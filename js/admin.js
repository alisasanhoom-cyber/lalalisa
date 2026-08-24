/* ===================================================================
   INTERNAL JOB TRACKER + SCHEDULE  (runs on admin.html)
   -------------------------------------------------------------------
   In plain English:
     1. Ask for the password, then remember it for this browser tab.
     2. Load all JOBS and all SCHEDULE entries from the server.
     3. Two tabs:
        - Job Tracker: your jobs ledger. Filter by month / booker / status,
          search, see monthly totals, edit any job, add or delete jobs.
        - Schedule: the day-by-day calendar (casting / options / jobs).
   =================================================================== */
(function () {
  const STORE_KEY = 'mp_admin_token';

  // Client & confirmation details a booker fills in (for quotation / contract /
  // confirmation form). The first two groups are plain text inputs; the
  // Schedule & fee group is custom-built (date/time pickers + overtime calculator).
  const CLIENT_SECTIONS = [
    ['Client company', [
      ['companyName', 'Company Name'], ['clientTaxId', 'Company Tax ID'],
      ['companyAddress', 'Company Address'], ['contactPerson', 'Contact Person'],
      ['contactNumber', 'Contact Number'], ['clientEmail', 'Email'],
    ]],
    ['Assignment', [
      ['product', 'Product'], ['role', 'Role'],
      ['mediaUsage', 'Media Usage'], ['periodOfUsage', 'Period of Usage'],
      ['countryOfUse', 'Country/ies of Use'], ['shootLocation', 'Shooting Location'],
    ]],
  ];
  // Every client/confirmation field (must match the server list).
  const CLIENT_KEYS = [
    ...CLIENT_SECTIONS.flatMap(([, fields]) => fields.map(([k]) => k)),
    'shootStart', 'shootEnd', 'timeStart', 'timeEnd', 'noOfShoot',
    'workPackage', 'contractHours', 'breakHours', 'overtimeRate', 'overtimeFee', 'paymentTerm', 'remark',
    'leadSource', 'clientCategory', 'signedDocUrl',
  ];

  // CRM — where a lead/client came from. Bookers pick one on every new job.
  const LEAD_SOURCES = ['Website', 'LINE', 'Instagram', 'Facebook', 'Email', 'Phone call',
    'WhatsApp', 'Referral', 'Repeat client', 'Agency', 'Walk-in', 'Other'];
  // CRM — client industry, for marketing segmentation.
  const CLIENT_CATEGORIES = ['Fashion', 'Commercial', 'Film & TV', 'Event organizer',
    'Magazine / Editorial', 'Agency', 'Other'];
  const CAT_ICON = { 'Fashion': '👗', 'Commercial': '📺', 'Film & TV': '🎬', 'Event organizer': '🎪',
    'Magazine / Editorial': '📰', 'Agency': '🏢', 'Other': '•' };
  const SOURCE_ICON = { 'Website': '🌐', 'LINE': '💬', 'Instagram': '📷', 'Facebook': '👍',
    'Email': '✉️', 'Phone call': '📞', 'WhatsApp': '📱', 'Referral': '🤝', 'Repeat client': '🔁',
    'Agency': '🏢', 'Walk-in': '🚶', 'Other': '•' };

  // Work packages. Presets pre-fill the contracted hours; "Custom" lets the booker
  // type ANY hours (shoots aren't always 4/8 anymore — flexible per job).
  const PACKAGES = {
    photo4:  { label: 'Photoshoot – 4 hours',        hours: 4,  brk: 0 },
    photo8:  { label: 'Photoshoot – 8 hours',        hours: 8,  brk: 0 },
    video12: { label: 'Video – 12 hours (1h break)', hours: 12, brk: 1 },
    custom:  { label: 'Custom hours…',               hours: null, brk: 0 },
  };
  const isISODate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

  let token = sessionStorage.getItem(STORE_KEY) || '';
  let role  = sessionStorage.getItem('mp_admin_role') || '';
  let jobs = [];
  let schedule = [];

  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Only master/admin see money (budgets, prices, revenue). Bookers do not.
  const canSeeMoney = () => role === 'master' || role === 'admin';
  function applyRole() {
    document.body.classList.toggle('role-booker', role === 'booker');
    // Graphic designer: browses jobs/schedule to source photos & videos, sees NO money at all.
    document.body.classList.toggle('role-designer', role === 'designer');
    // Scouter (external): only their own Mother-Agency ledger + their models' schedule.
    document.body.classList.toggle('role-scouter', role === 'scouter');
    const who = el('whoami');
    if (who) {
      const name = sessionStorage.getItem('mp_admin_name') || '';
      const roleLabel = role === 'master' ? 'Director' : role === 'admin' ? 'Admin'
        : role === 'designer' ? 'Graphic Designer' : role === 'scouter' ? 'Scouter' : 'Booker';
      who.textContent = name ? `${name} · ${roleLabel}` : roleLabel;
    }
  }

  /* ================= 1. AUTH ================= */
  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('login-err').textContent = '';
    if (!el('email').value.trim()) { el('login-err').textContent = 'Please enter your email.'; return; }
    const res = await fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: el('email').value.trim(), password: el('pw').value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.token) {
      token = data.token; role = data.role || 'booker';
      sessionStorage.setItem(STORE_KEY, token);
      sessionStorage.setItem('mp_admin_role', role);
      sessionStorage.setItem('mp_admin_name', data.name || '');
      sessionStorage.setItem('mp_admin_bookername', data.bookerName || '');
      sessionStorage.setItem('mp_admin_email', (el('email') ? el('email').value : '').trim().toLowerCase());
      start();
    } else {
      el('login-err').textContent = data.error || 'Incorrect email or password.';
    }
  });
  // Let people reveal the password so a phone typo is obvious.
  const pwToggle = el('pw-toggle');
  if (pwToggle) pwToggle.addEventListener('click', () => {
    const pw = el('pw');
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    pwToggle.textContent = show ? 'Hide' : 'Show';
  });
  el('logout').addEventListener('click', () => {
    // Invalidate the session server-side too, so the token can't be replayed.
    fetch('/api/logout', { method: 'POST', headers: { 'x-admin-token': token } }).catch(() => {});
    ['mp_admin_token', 'mp_admin_role', 'mp_admin_name', 'mp_admin_bookername'].forEach(k => sessionStorage.removeItem(k));
    token = ''; role = ''; showLogin();
  });
  function showLogin() { el('app').style.display = 'none'; el('login').style.display = 'flex'; }
  function showApp()   { el('login').style.display = 'none'; el('app').style.display = 'block'; applyRole(); }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token, ...(opts.headers || {}) },
    });
    if (res.status === 401) { sessionStorage.removeItem(STORE_KEY); showLogin(); throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    // A rejected write must NOT look like success — throw so callers' catch blocks
    // actually run (rollbacks, error messages) instead of silently "saving".
    if (!res.ok) {
      const err = new Error(data.error || ('Request failed (' + res.status + ')'));
      err.status = res.status; err.body = data;
      throw err;
    }
    return data;
  }

  /* ================= 2. LOAD DATA ================= */
  // Order-independent fingerprint of a list, so we only re-render on a REAL change
  // (not because the server returned the same items in a different order).
  const fingerprint = arr => (arr || []).map(x => JSON.stringify(x)).sort().join('|');
  async function loadAll() {
    if (role === 'scouter') {
      // Scouter: no jobs access — just their models' schedule + their MAC ledger.
      const b = await api('/api/schedule').catch(() => ({ schedule: [] }));
      schedule = b.schedule || [];
      api('/api/models').then(r => { models = r.models || []; }).catch(() => {});
      api('/api/settings').then(s => { appSettings = s || {}; if (s && s.fxRates) fxRates = s.fxRates; }).catch(() => {});
      buildFilters(); renderSchedule();
      return;
    }
    const [a, b] = await Promise.all([api('/api/jobs'), api('/api/schedule')]);
    jobs = a.jobs || [];
    schedule = b.schedule || [];
    api('/api/settings').then(s => { appSettings = s || {}; if (s && s.fxRates) fxRates = s.fxRates; renderJobs(); }).catch(() => {});
    buildFilters();
    renderJobs();
    renderSchedule();
    // Load the model directory quietly so Notify can auto-fill contacts anywhere.
    api('/api/models').then(r => { models = r.models || []; }).catch(() => {});
  }

  // Auto-refresh: the team all work at once, so pull fresh jobs + schedule in the
  // background and re-render when anything changed — no more manual Refresh. We stay
  // out of the way while someone is actively editing (drawer open / typing in a field).
  async function silentRefresh() {
    if (role === 'scouter') return;   // scouter has no jobs feed; uses its own refresh
    if (document.hidden) return;
    if (el('drawer').classList.contains('open')) return;
    const a = document.activeElement;
    if (a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName)) return;
    try {
      const [ja, sb] = await Promise.all([api('/api/jobs'), api('/api/schedule')]);
      const nj = ja.jobs || [], ns = sb.schedule || [];
      // Compare to what is on screen now, so a local save (already applied) will not re-render.
      if (fingerprint(nj) === fingerprint(jobs) && fingerprint(ns) === fingerprint(schedule)) return;
      jobs = nj; schedule = ns;
      buildFilters(); renderJobs(); renderSchedule();
    } catch (_) { /* offline / logged out — try again next tick */ }
  }
  setInterval(silentRefresh, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) silentRefresh(); });
  window.addEventListener('focus', silentRefresh);

  // Auto-update: bookers keep the tab open all day, so we notice when a new version
  // is deployed and offer a one-click reload. We NEVER yank the page out from under
  // someone: a visible tab just shows a small "reload" bar; only a background tab
  // reloads on its own — and never more than once per few minutes (loop guard).
  // The running code's version = the ?v= on our own <script> tag (stamped per deploy).
  let loadedVersion = (() => {
    const s = [...document.querySelectorAll('script')].find(x => /js\/admin\.js/.test(x.src || ''));
    const m = s && s.src.match(/[?&]v=([a-z0-9]+)/i);
    return m ? m[1] : null;
  })();
  function showUpdateBar() {
    if (el('update-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'update-bar';
    bar.innerHTML = 'A new version is ready. <button id="update-now">Reload</button>';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#16211d;color:#fff;'
      + 'padding:10px 16px;text-align:center;font-size:13px;font-family:inherit';
    document.body.appendChild(bar);
    const btn = bar.querySelector('#update-now');
    btn.style.cssText = 'margin-left:10px;background:#2f8f83;color:#fff;border:none;border-radius:7px;padding:5px 14px;cursor:pointer;font-weight:600';
    btn.addEventListener('click', () => location.reload());
  }
  let updatePending = false;
  // Safe to reload = nobody is mid-edit (no drawer open, not typing in a field).
  function safeReloadNow() {
    if (el('drawer') && el('drawer').classList.contains('open')) return false;
    const a = document.activeElement;
    if (a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName)) return false;
    return true;
  }
  function reloadOnce() {
    let last = 0; try { last = +(sessionStorage.getItem('mp_reload_at') || 0); } catch (_) {}
    if (new Date().getTime() - last < 60000) return;   // loop guard
    try { sessionStorage.setItem('mp_reload_at', String(new Date().getTime())); } catch (_) {}
    location.reload();
  }
  async function checkVersion() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const v = (await r.json()).version;
      if (!v) return;
      if (loadedVersion === null) { loadedVersion = v; return; }   // first read = our version
      if (v === loadedVersion) return;                             // unchanged — do nothing
      updatePending = true;                                        // a newer version is live
      // Reload as soon as it's safe (background tab, or foreground with nothing being
      // edited) so stale tabs can't keep sending old messages. Otherwise show the bar.
      if (document.hidden || safeReloadNow()) reloadOnce();
      else showUpdateBar();
    } catch (_) { /* offline — try again next tick */ }
  }
  setInterval(checkVersion, 60000);
  checkVersion();   // establish/confirm version right away
  // When the booker comes back to the tab, or finishes editing, apply a pending update.
  const applyIfPending = () => { if (updatePending && !document.hidden && safeReloadNow()) reloadOnce(); };
  window.addEventListener('focus', applyIfPending);
  document.addEventListener('visibilitychange', applyIfPending);

  /* ================= 3. HELPERS ================= */
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function monthLabel(m) {                 // '2026-08' -> 'Aug 2026'
    const [y, mm] = (m || '').split('-');
    return mm ? `${MONTH_NAMES[+mm - 1]} ${y}` : m;
  }
  const CUR_SYM = { THB: '฿', USD: '$', CNY: '¥', EUR: '€' };
  let fxRates = { USD: 35, EUR: 38, CNY: 5 };   // → THB, updated from /api/settings
  let appSettings = {};                          // full /api/settings (driveUploadUrl etc.)
  // overtimeFee can be a NUMBER ("9375" / "9,375") or a CONDITION the booker wrote
  // ("1,250/hour after 13 hours"). Only a clean number counts in totals — the
  // condition is printed on the confirmation and becomes a number once known.
  function otNum(v) {
    const s = String(v == null ? '' : v).trim();
    // Commas must be real thousands groups: "12,50" (European decimal comma)
    // is NOT ฿1,250 — ambiguous strings count as condition text, never money.
    if (!s || !/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s)) return 0;
    return Number(s.replace(/,/g, '')) || 0;
  }
  // A job's full amount = budget + overtime fee. Lines-jobs already fold each
  // model's OT into budget (linesTotal), so only single-model jobs add the field.
  function jobAmount(j) {
    const ot = (Array.isArray(j.lines) && j.lines.length) ? 0 : otNum(j.overtimeFee);
    return Number(j.budget || 0) + ot;
  }
  // Convert any job's full amount to THB (THB stays as-is; foreign × its rate).
  function toThb(j) {
    const cur = j.currency || 'THB', amt = jobAmount(j);
    return cur === 'THB' ? amt : amt * (fxRates[cur] || 0);
  }
  // Budget cell: THB jobs plain; foreign jobs show the THB equivalent + a tag with
  // the original foreign amount (so you know it was converted). OT is included
  // in the figure, marked with ⏱ so the base fee is still traceable.
  function budgetCell(j) {
    if (!jobAmount(j)) return '—';
    const cur = j.currency || 'THB';
    const singleJob = !Array.isArray(j.lines) || !j.lines.length;
    const otTag = singleJob && otNum(j.overtimeFee)
      ? ` <span class="fx-tag" title="includes overtime ${money(otNum(j.overtimeFee), cur)} (base fee ${money(j.budget, cur)})">⏱ OT</span>`
      : (singleJob && String(j.overtimeFee || '').trim()
        ? ` <span class="fx-tag" title="OT condition: ${esc(j.overtimeFee)} — not in total until a number is entered">⏱ cond.</span>` : '');
    if (cur === 'THB') return money(jobAmount(j), 'THB') + otTag;
    return `${money(toThb(j))} <span class="fx-tag" title="Converted from ${cur} at ฿${fxRates[cur] || '?'}/${CUR_SYM[cur] || cur}">🌐 ${money(jobAmount(j), cur)}</span>${otTag}`;
  }
  function money(n, cur) { return (CUR_SYM[cur] || '฿') + Math.round(Number(n || 0)).toLocaleString('en-US'); }
  // Thousands separators that PRESERVE decimals — stripping the dot corrupted
  // amounts like 1234.50 → 123450 (10× per decimal place).
  const withCommas = v => {
    let s = String(v == null ? '' : v).replace(/[^\d.]/g, '');
    if (!s) return '';
    const firstDot = s.indexOf('.');
    if (firstDot >= 0) s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
    const [int, dec] = s.split('.');
    const intFmt = int ? Number(int).toLocaleString('en-US') : (firstDot === 0 ? '0' : '');
    return dec !== undefined ? intFmt + '.' + dec.slice(0, 2) : intFmt;
  };
  function distinct(arr) { return [...new Set(arr.filter(Boolean))]; }

  // Everyone who can own a job/lead: the names seen in the data plus the fixed
  // team (so Admin — who handles visa/work-permit tasks — is always selectable).
  const EXTRA_BOOKERS = ['Admin'];
  function bookerRoster() {
    return distinct(jobs.map(j => j.booker).concat(schedule.map(s => s.booker), EXTRA_BOOKERS))
      .filter(Boolean).sort();
  }

  function buildFilters() {
    // Months: newest first
    const months = distinct(jobs.map(j => j.month).concat(schedule.map(s => s.month)))
      .sort().reverse();
    const opts = ['<option value="all">All months</option>']
      .concat(months.map(m => `<option value="${m}">${monthLabel(m)}</option>`)).join('');
    // Preserve the current selection across rebuilds; on first load default to the
    // CURRENT month (fall back to the latest month with data if this month is empty).
    const curYM = todayLocal().slice(0, 7);
    const prevJ = el('j-month').value, prevS = el('s-month').value;
    el('j-month').innerHTML = opts;
    el('s-month').innerHTML = opts;
    const pick = (prev, pool) => {
      if (prev && (prev === 'all' || months.includes(prev))) return prev;   // keep valid choice
      if (months.includes(curYM)) return curYM;                             // else this month
      return (distinct(pool).sort().reverse()[0] || 'all');                 // else latest with data
    };
    el('j-month').value = pick(prevJ, jobs.map(j => j.month));
    el('s-month').value = pick(prevS, schedule.map(s => s.month));

    // Bookers (used by both the Job Tracker and Schedule filters)
    const bkOpts = bookerRoster().map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
    const jb = el('j-booker').value, sb = el('s-booker').value;
    el('j-booker').innerHTML = '<option value="">All bookers</option>' + bkOpts; el('j-booker').value = jb;
    el('s-booker').innerHTML = '<option value="">All bookers</option>' + bkOpts; el('s-booker').value = sb;
  }

  // Small inline booker dropdown used to tag a schedule entry in one click.
  function inlineBookerSelect(e) {
    return `<select class="inline-booker ${e.booker ? '' : 'untagged'}" data-id="${e.id}">
      <option value="">— booker —</option>
      ${bookerRoster().map(b => `<option value="${esc(b)}" ${e.booker === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}
    </select>`;
  }
  async function setEntryBooker(id, booker) {
    const r = await api('/api/schedule/' + id, { method: 'PATCH', body: JSON.stringify({ booker }) });
    const e = schedule.find(x => x.id === id);
    if (e) e.booker = r.entry.booker;
  }

  // Lead status (Open → Confirmed / Postponed / Declined) for a schedule entry.
  const LEAD_STATUSES = [['open', 'Open'], ['confirmed', 'Confirmed'], ['postponed', 'Postponed'], ['declined', 'Declined']];
  function inlineStatusSelect(e) {
    const cur = e.status || 'open';
    return `<select class="inline-status st-${cur}" data-id="${e.id}">
      ${LEAD_STATUSES.map(([k, l]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${l}</option>`).join('')}
    </select>`;
  }
  // Auto-pilot: the Status drop-down drives the Board so nobody has to re-tag by hand.
  //   Confirmed → the booking jumps to "Confirmed / Shooting"
  //   Declined  → it drops off the board (declined is hidden there)
  async function setEntryStatus(id, status) {
    const patch = { status };
    if (status === 'confirmed') patch.stage = 'shooting';   // move to the green Confirmed/Shooting box
    const r = await api('/api/schedule/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
    const e = schedule.find(x => x.id === id);
    if (e) { e.status = r.entry.status; e.stage = r.entry.stage; }
    // A multi-day hold moves as ONE booking — declining/postponing/reopening one
    // day applies to every held day (same as dragging the hold on the Board).
    if (e && e.holdGroup) {
      const siblings = schedule.filter(x => x.holdGroup === e.holdGroup && x.id !== e.id);
      for (const s of siblings) {
        try { const rs = await api('/api/schedule/' + s.id, { method: 'PATCH', body: JSON.stringify(patch) }); s.status = rs.entry.status; s.stage = rs.entry.stage; }
        catch (_) {}
      }
    }
  }
  // Auto-pilot: confirming an OPTION books it. Decline the other held days of the
  // same option, then drop a confirmed Job into the Job Tracker (fee added later).
  // Returns true if it ran, false if the booker cancelled.
  async function confirmOptionToJob(e) {
    const siblings = e.holdGroup
      ? schedule.filter(x => x.holdGroup === e.holdGroup && x.id !== e.id && x.status !== 'declined')
      : [];
    const msg = siblings.length
      ? `Client confirmed ${e.date}.\n\nThis will:\n• decline the other ${siblings.length} held day(s)\n• create a confirmed Job in the Job Tracker (add the fee later)\n\nContinue?`
      : `Confirm ${e.date} and create a Job in the Job Tracker (add the fee later)?`;
    if (!confirm(msg)) return false;
    for (const s of siblings) {
      await api('/api/schedule/' + s.id, { method: 'PATCH', body: JSON.stringify({ status: 'declined' }) });
      s.status = 'declined';
    }
    const prefill = jobPrefillFromEntry(e);
    prefill.shootDays = e.shootDays || '';
    const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify(prefill) });
    if (r.job) jobs.unshift(r.job);
    await api('/api/schedule/' + e.id, { method: 'PATCH', body: JSON.stringify({ status: 'confirmed', jobCreated: true, stage: 'shooting' }) });
    e.status = 'confirmed'; e.jobCreated = true; e.stage = 'shooting';
    return true;
  }

  // Wire the inline booker + status dropdowns inside a rendered container.
  function wireInlineBookers(root) {
    root.querySelectorAll('.inline-booker').forEach(sel => {
      sel.addEventListener('click', ev => ev.stopPropagation());
      sel.addEventListener('change', async ev => {
        await setEntryBooker(sel.dataset.id, ev.target.value);
        sel.classList.toggle('untagged', !ev.target.value);
        renderJobs(); renderSchedule();  // reflect the change on the calendar/board too
      });
    });
    root.querySelectorAll('.inline-status').forEach(sel => {
      sel.addEventListener('click', ev => ev.stopPropagation());
      sel.addEventListener('change', async ev => {
        const id = sel.dataset.id, val = ev.target.value;
        const e = schedule.find(x => x.id === id);
        // Confirming an OPTION (not a casting) auto-books it: decline the other held
        // days + create the job. Castings just change status normally.
        if (val === 'confirmed' && e && e.option && !e.job && !e.jobCreated) {
          const ok = await confirmOptionToJob(e);
          if (!ok) { ev.target.value = e.status; sel.className = 'inline-status st-' + e.status; return; }
          renderJobs(); buildFilters(); renderSchedule();
          if (el('drawer').classList.contains('open')) openDay(e.date);
          alert('✓ Confirmed. A job was created in the Job Tracker (add the fee when the client sends it), and the other held days were declined.');
          return;
        }
        await setEntryStatus(id, val);
        sel.className = 'inline-status st-' + val;
        renderJobs(); renderSchedule();   // update counts + re-sort/hide on calendar/board
        if (el('drawer').classList.contains('open')) openDay(e.date);
      });
    });
  }

  /* ================= 4. JOB TRACKER ================= */
  // A job is a Non-Tax invoice (paid to the SCB account) when it has a B-code and
  // no C-code; otherwise it's a Tax invoice (paid to the KBank company account).
  // NOTE: this is about the CLIENT's invoice type — NOT whether the model is
  // freelance or MP. Either model type can be billed with or without tax.
  // ---- Remembered clients ------------------------------------------
  // Bookers shouldn't retype a client they've used before. We remember every
  // client name AND the company details last entered for them, so picking the
  // name auto-fills the rest of the confirmation block.
  const CLIENT_COMPANY_KEYS = ['companyName', 'clientTaxId', 'companyAddress', 'contactPerson', 'contactNumber', 'clientEmail'];
  function clientNames() {
    return distinct(jobs.map(j => (j.client || '').trim()).filter(Boolean))
      .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  }
  function clientMemory(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    const mem = {};
    // jobs is newest-first, so the first non-empty value we see is the most recent.
    for (const j of jobs) {
      if ((j.client || '').trim().toLowerCase() !== key) continue;
      CLIENT_COMPANY_KEYS.forEach(k => { if (mem[k] == null && j[k]) mem[k] = j[k]; });
    }
    return Object.keys(mem).length ? mem : null;
  }
  function clientDatalist() {
    return `<datalist id="client-list">${clientNames().map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist>`;
  }
  // Fill the confirmation company fields from a remembered client — but never
  // overwrite anything the booker has already typed.
  function autofillClient(name) {
    const mem = clientMemory(name);
    if (!mem) return;
    CLIENT_COMPANY_KEYS.forEach(k => {
      const inp = el('d-' + k);
      if (inp && !inp.value.trim() && mem[k]) inp.value = mem[k];
    });
  }

  function isNonTax(j) {
    const hasC = /C\s?\d/i.test(j.jobId || '');
    const hasB = /B\s?\d/i.test((j.jobIdNonTax || '') + ' ' + (j.jobId || ''));
    return hasB && !hasC;
  }

  function filteredJobs() {
    const month = el('j-month').value;
    const booker = el('j-booker').value;
    const invtype = el('j-invtype') ? el('j-invtype').value : '';
    const term = el('j-search').value.trim().toLowerCase();
    return jobs.filter(j => {
      if (month !== 'all' && j.month !== month) return false;
      if (booker && j.booker !== booker) return false;
      if (invtype === 'tax' && isNonTax(j)) return false;       // show only C (tax invoice)
      if (invtype === 'nontax' && !isNonTax(j)) return false;   // show only B (non-tax)
      if (term) {
        const hay = [j.jobTitle, j.model, j.freelance, j.client, j.booker, j.jobId, j.jobIdNonTax]
          .join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }
  // Sort by the job CODE so the tracker runs in code order (…B1110, B1111, B1112,
  // then C3020, C3021, C3022…). B-codes (all lower numbers) group before C-codes.
  // Jobs with no code yet sink to the bottom.
  const jobCodeNum = j => { const m = String(j.jobId || j.jobIdNonTax || '').match(/\d{3,6}/); return m ? +m[0] : 0; };
  function sortedJobs() {
    return filteredJobs().slice().sort((a, b) => {
      const na = jobCodeNum(a) || Infinity, nb = jobCodeNum(b) || Infinity;
      return na - nb || (a.bookingDate || '').localeCompare(b.bookingDate || '');
    });
  }

  function renderJobs() {
    const list = sortedJobs();

    // Counts (everyone sees these). Castings/Options follow the month + booker
    // filter — an entry counts for a booker only once it's tagged with that booker.
    const month = el('j-month').value;
    const bookerSel = el('j-booker').value;
    const monthSched = schedule.filter(e =>
      (month === 'all' || e.month === month) && (!bookerSel || e.booker === bookerSel));
    const castings = monthSched.filter(e => e.casting).length;
    const options = monthSched.filter(e => e.option).length;

    // Team total is in THB — foreign-currency jobs are CONVERTED to THB and included.
    // The bank-account totals (KBank/SCB) stay pure THB (those accounts only hold THB).
    const curOf = j => j.currency || 'THB';
    const thb = list.filter(j => curOf(j) === 'THB');
    const totalBudget = list.reduce((s, j) => s + toThb(j), 0);           // THB + converted foreign
    const taxBudget = thb.filter(j => !isNonTax(j)).reduce((s, j) => s + jobAmount(j), 0);
    const nonTaxBudget = thb.filter(j => isNonTax(j)).reduce((s, j) => s + jobAmount(j), 0);
    const foreignCount = list.filter(j => curOf(j) !== 'THB' && jobAmount(j)).length;
    const foreignTiles = ['USD', 'EUR', 'CNY'].map(c => {
      const rows = list.filter(j => curOf(j) === c && jobAmount(j));
      if (!rows.length) return '';
      const sum = rows.reduce((s, j) => s + jobAmount(j), 0);
      const thbEq = rows.reduce((s, j) => s + toThb(j), 0);
      return `<div class="stat money revenue-only"><div class="n">${money(sum, c)}</div><div class="l">${c} · ≈${money(thbEq)} <span class="fx-edit" data-cur="${c}" title="Edit rate">✎ ฿${fxRates[c]}</span></div></div>`;
    }).join('');

    // Each booker sees their OWN sales total (THB) — not the company-wide totals.
    let mySalesTile = '';
    if (role === 'booker') {
      const mine = sessionStorage.getItem('mp_admin_bookername') || '';
      if (mine) {
        const mySum = list.filter(j => (j.booker || '').toLowerCase() === mine.toLowerCase())
          .reduce((s, j) => s + toThb(j), 0);
        mySalesTile = `<div class="stat money"><div class="n">${money(mySum)}</div><div class="l">My sales · ${esc(mine)}</div></div>`;
      }
    }

    el('j-stats').innerHTML = `
      <div class="stat"><div class="n">${list.length}</div><div class="l">Jobs</div></div>
      <div class="stat"><div class="n">${castings}</div><div class="l">Castings (leads)</div></div>
      <div class="stat"><div class="n">${options}</div><div class="l">Options (leads)</div></div>
      ${mySalesTile}
      ${(canSeeMoney() || month !== 'all')
        ? `<div class="stat money"><div class="n">${money(totalBudget)}</div><div class="l">Team total (THB)${foreignCount ? ' · incl. ' + foreignCount + ' foreign' : ''}</div></div>`
        : `<div class="stat money"><div class="n">🔒</div><div class="l">Year total — Director &amp; Admin only · pick a month</div></div>`}
      <div class="stat money revenue-only"><div class="n">${money(taxBudget)}</div><div class="l">Tax invoice · KBank</div></div>
      <div class="stat money nontax revenue-only"><div class="n">${money(nonTaxBudget)}</div><div class="l">Non-Tax · SCB</div></div>
      ${foreignTiles}`;

    // Managers can edit an exchange rate by clicking the ✎ on a foreign tile.
    el('j-stats').querySelectorAll('.fx-edit').forEach(sp => {
      if (!canSeeMoney()) return;
      sp.style.cursor = 'pointer';
      sp.addEventListener('click', async () => {
        const cur = sp.dataset.cur;
        const v = prompt(`Exchange rate — how many THB per 1 ${cur}?`, fxRates[cur]);
        if (v == null) return;
        const rate = parseFloat(String(v).replace(/[^\d.]/g, ''));
        if (!rate || rate <= 0) { alert('Enter a number greater than 0.'); return; }
        fxRates[cur] = rate;
        try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ fxRates: { [cur]: rate } }) }); } catch (_) {}
        renderJobs();
      });
    });

    el('j-empty').style.display = list.length ? 'none' : 'block';
    const jobRowHtml = j => {
      // Split the code into its own column: C-code = Tax, B-code = Non-Tax.
      const taxCode = /b\s?\d/i.test(j.jobId || '') ? '' : (j.jobId || '');   // C (or blank)
      const nonTaxCode = j.jobIdNonTax || (/b\s?\d/i.test(j.jobId || '') ? j.jobId : '');   // B
      let who;
      if (Array.isArray(j.lines) && j.lines.length) {
        const parts = j.lines.map(l => `<b>${esc(l.name) || '—'}</b> ฿${withCommas((+l.rate || 0) + (+l.ot || 0))}${l.mp ? '' : ' <span style="color:var(--web)">FL</span>'}`);
        who = `<span>${j.lines.length} models</span><span class="job-lines">${parts.join('<br>')}</span>`;
      } else {
        who = [j.model, j.freelance].filter(Boolean).map(esc).join(' / ') || '—';
      }
      const webBadge = j.source === 'website' ? ' <span class="badge web">web</span>' : '';
      const usageBadge = isUsageJob(j) ? ' <span class="badge usage" title="Additional usage fee — re-uses an existing job code">🔁 usage fee</span>' : '';
      return `
      <tr class="row ${j.source === 'website' ? 'web' : ''}${j.collected ? ' collected' : ''}" data-id="${j.id}">
        <td class="col-collected"><input type="checkbox" class="collect-box" data-id="${j.id}"${j.collected ? ' checked' : ''} title="Collected — photos/videos gathered"></td>
        <td>${esc(j.jobDate) || '—'}</td>
        <td class="code-c">${esc(taxCode) || '<span class="code-dash">—</span>'}</td>
        <td class="code-b">${esc(nonTaxCode) || '<span class="code-dash">—</span>'}</td>
        <td class="title-cell"><span class="conf-icon ${j.confirmationMade ? 'done' : ''}" data-id="${j.id}" title="${j.confirmationMade ? 'Confirmation made ✓ (click to unmark)' : 'Confirmation not made yet (click when done)'}">${j.confirmationMade ? '📄✓' : '📄'}</span><span class="prev-icon" data-id="${j.id}" title="Preview this job's confirmation form">👁</span>${j.signedDocUrl ? ` <a href="${esc(j.signedDocUrl)}" target="_blank" rel="noopener" class="signed-link" title="Client signed ✓ — open the signed confirmation" onclick="event.stopPropagation()">🖊️✓</a>` : ''} ${esc(j.jobTitle) || '—'}${webBadge}${usageBadge}${matBadge(j.materials)}${j.internalNote ? ' <span class="note-dot" title="Has an internal note">📝</span>' : ''}</td>
        <td>${who}</td>
        <td>${esc(j.client) || '—'}${j.leadSource ? ` <span class="src-badge" title="Lead source">${SOURCE_ICON[j.leadSource] || ''} ${esc(j.leadSource)}</span>` : ''}</td>
        <td>${esc(j.booker) || '—'}</td>
        <td class="num money">${budgetCell(j)}</td>
      </tr>`;
    };
    // When viewing ALL months, group by month with a header (like the old monthly
    // sheets) so the full code sequence is visible and you see which month each is.
    if (el('j-month').value === 'all') {
      const byMonth = {};
      list.forEach(j => { const m = j.month || '(no month)'; (byMonth[m] = byMonth[m] || []).push(j); });
      const months = Object.keys(byMonth).sort().reverse();   // newest month first
      el('j-rows').innerHTML = months.map(m => {
        const rows = byMonth[m].map(jobRowHtml).join('');
        return `<tr class="month-head"><td colspan="9">📅 ${m === '(no month)' ? 'No month' : monthLabel(m)} · ${byMonth[m].length} jobs</td></tr>` + rows;
      }).join('');
    } else {
      // Single-month view: show the jobs PLUS marker rows for codes that fall inside
      // this month's number range but live elsewhere — a July job, or a free code —
      // so the sequence is unbroken and bookers see which codes are already taken.
      el('j-rows').innerHTML = jobRowsWithGaps(list, jobRowHtml);
    }

    // Inline "collected" tick — toggles without opening the job.
    el('j-rows').querySelectorAll('.collect-box').forEach(cb => {
      cb.addEventListener('click', ev => ev.stopPropagation());
      cb.addEventListener('change', async ev => {
        const jb = jobs.find(x => x.id === cb.dataset.id);
        if (jb) jb.collected = cb.checked;
        cb.closest('tr').classList.toggle('collected', cb.checked);
        try { await api('/api/jobs/' + cb.dataset.id, { method: 'PATCH', body: JSON.stringify({ collected: cb.checked }) }); } catch (_) {}
      });
    });
    // Click the 📄 icon to mark/unmark "confirmation made" — without opening the job.
    el('j-rows').querySelectorAll('.conf-icon').forEach(ic => {
      ic.addEventListener('click', async ev => {
        ev.stopPropagation();
        const jb = jobs.find(x => x.id === ic.dataset.id); if (!jb) return;
        jb.confirmationMade = !jb.confirmationMade;
        renderJobs();
        try { await api('/api/jobs/' + jb.id, { method: 'PATCH', body: JSON.stringify({ confirmationMade: jb.confirmationMade }) }); } catch (_) {}
      });
    });
    // 👁 per-row preview: open THIS job's confirmation form straight from the tracker.
    el('j-rows').querySelectorAll('.prev-icon').forEach(ic => {
      ic.addEventListener('click', ev => {
        ev.stopPropagation();
        const jb = jobs.find(x => x.id === ic.dataset.id); if (!jb) return;
        openConfirmationDoc({ ...jb });
      });
    });
    el('j-rows').querySelectorAll('tr.row').forEach(tr =>
      tr.addEventListener('click', () => openJob(tr.dataset.id)));
    // Click a free-code marker → new job pre-filled with that exact code.
    el('j-rows').querySelectorAll('tr.gap-free').forEach(tr =>
      tr.addEventListener('click', () => {
        const code = tr.dataset.newcode;
        const prefill = { _codeOnly: true };
        if (/^C/i.test(code)) prefill.jobId = code; else prefill.jobIdNonTax = code;
        openJob(null, prefill);
      }));
  }

  // Parse a "C3016-MV" / "B1108-PHOTO" code into {p:'C', n:3016, usage:'/1'|null}.
  // A "/N" suffix (e.g. B1045/1) marks an ADDITIONAL USAGE fee of an existing job —
  // it re-uses an old code and is NOT part of the current running sequence.
  function parseCode(str) {
    const s = String(str || '');
    const m = s.match(/([CB])\s?(\d{3,})/i);
    if (!m) return null;
    const usage = s.match(new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*/\\s*(\\d+)'));
    return { p: m[1].toUpperCase(), n: +m[2], usage: usage ? usage[1] : null };
  }
  const isUsageJob = j => { const c = parseCode(j.jobId || j.jobIdNonTax); return !!(c && c.usage); };
  // Where does code <prefix><n> live? Returns that job's month, or null if the code
  // is free (used by nobody) — searched across ALL jobs, every month.
  function codeMonth(prefix, n) {
    const re = new RegExp('(^|[^0-9])' + prefix + '\\s?' + n + '(?![0-9])', 'i');
    const j = jobs.find(x => re.test((x.jobId || '') + ' ' + (x.jobIdNonTax || '')));
    return j ? (j.month || '') : null;
  }
  // Build the month's rows with gap-marker rows woven in (like the old "JOB IN JULY").
  function jobRowsWithGaps(list, rowHtml) {
    const out = [];
    const MAX_GAP = 15;   // don't fill huge gaps (e.g. an old usage-fee code far below the sequence)
    ['C', 'B'].forEach(prefix => {
      const coded = list.map(j => ({ j, c: parseCode(j.jobId || j.jobIdNonTax) }))
        .filter(x => x.c && x.c.p === prefix).sort((a, b) => a.c.n - b.c.n);
      for (let i = 0; i < coded.length; i++) {
        out.push({ sort: prefix === 'B' ? coded[i].c.n : 100000 + coded[i].c.n, html: rowHtml(coded[i].j) });
        // Usage-fee codes (B1045/1) aren't part of the running sequence — skip gaps after them.
        if (coded[i].c.usage) continue;
        const cur = coded[i].c.n, nxt = i + 1 < coded.length ? coded[i + 1].c.n : null;
        if (nxt && nxt > cur + 1 && (nxt - cur - 1) <= MAX_GAP) {
          // walk the missing numbers, grouping consecutive ones with the same home
          let runStart = null, runHome;
          const flush = (endN) => {
            if (runStart == null) return;
            const range = runStart === endN ? prefix + runStart : prefix + runStart + '–' + prefix + endN;
            if (runHome) {
              // These codes belong to another month's job — informational only, not free.
              out.push({ sort: (prefix === 'B' ? 0 : 100000) + runStart + 0.5, marker: true,
                html: `<tr class="gap-row"><td class="col-collected"></td><td></td><td colspan="7">${prefix === 'C' ? '↳ ' : ''}${range} · 📅 ${monthLabel(runHome)}</td></tr>` });
            } else {
              // Genuinely free — click to start a new job pre-filled with the first free code.
              out.push({ sort: (prefix === 'B' ? 0 : 100000) + runStart + 0.5, marker: true,
                html: `<tr class="gap-row gap-free" data-newcode="${prefix + runStart}" title="Click to create a job with code ${prefix + runStart}"><td class="col-collected"></td><td></td><td colspan="7">${prefix === 'C' ? '↳ ' : ''}${range} · ⚪ free — <b>click to create</b> ${prefix + runStart}</td></tr>` });
            }
            runStart = null;
          };
          for (let k = cur + 1; k < nxt; k++) {
            const home = codeMonth(prefix, k);   // '' month string or null(free)
            const key = home || '__free__';
            if (runStart == null) { runStart = k; runHome = home; }
            else if (key !== (runHome || '__free__')) { flush(k - 1); runStart = k; runHome = home; }
          }
          flush(nxt - 1);
        }
      }
    });
    // no-code jobs at the very end
    list.filter(j => !parseCode(j.jobId || j.jobIdNonTax)).forEach(j => out.push({ sort: 1e9, html: rowHtml(j) }));
    out.sort((a, b) => a.sort - b.sort);
    return out.map(x => x.html).join('');
  }

  // Small photos/videos status chip on a job row (bookers never see it — CSS-gated).
  function matBadge(m) {
    const map = {
      searching: ['⏳ searching', 'mat-search'],
      found:     ['📷 found', 'mat-found'],
      done:      ['✓ done', 'mat-done'],
    };
    if (!map[m]) return '';
    return ` <span class="mat-badge ${map[m][1]}">${map[m][0]}</span>`;
  }

  ['j-month', 'j-booker', 'j-invtype', 'j-search'].forEach(idc =>
    el(idc).addEventListener('input', renderJobs));
  el('j-refresh').addEventListener('click', loadAll);
  // Ploy's master tick: sets/clears "collected" on every job the current
  // filter shows (asks first — this touches many records at once).
  const collectAll = el('collect-all');
  if (collectAll) collectAll.addEventListener('change', async () => {
    const want = collectAll.checked;
    const list = filteredJobs().filter(j => !!j.collected !== want);
    if (!list.length) return;
    if (!confirm((want ? 'Tick' : 'Untick') + ' ALL ' + list.length + ' shown jobs as collected?')) {
      collectAll.checked = !want; return;
    }
    collectAll.disabled = true;
    for (let i = 0; i < list.length; i += 8) {
      await Promise.all(list.slice(i, i + 8).map(j =>
        api('/api/jobs/' + j.id, { method: 'PATCH', body: JSON.stringify({ collected: want }) })
          .then(() => { j.collected = want; }).catch(() => {})));
    }
    collectAll.disabled = false;
    renderJobs();
    toast((want ? 'Ticked ' : 'Unticked ') + list.length + ' jobs as collected');
  });

  /* ---- Excel export (Aim: billing / ส่งเบิก needs the tracker as a file) ---- */
  // CSV with a UTF-8 BOM → opens directly in Excel with Thai text intact.
  function jobsCsvRows(list) {
    const cell = v => {
      v = String(v == null ? '' : v);
      if (/^[=+\-@]/.test(v)) v = "'" + v;                 // formula-injection guard
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const head = ['Booking date', 'Job date', 'C code', 'B code', 'Job title', 'Model', 'MP / Freelance',
      'Client', 'Company', 'Tax ID', 'Contact person', 'Email', 'Booker', 'Status', 'Shoot days',
      'Fee', 'OT', 'Total', 'Currency', 'Lead source', 'Confirmation made', 'Signed doc', 'Note'];
    const lines = [head.map(cell).join(',')];
    let grand = 0;
    list.forEach(j => {
      const base = [j.bookingDate, j.jobDate, (/b\s?\d/i.test(j.jobId || '') ? '' : j.jobId), j.jobIdNonTax || (/b\s?\d/i.test(j.jobId || '') ? j.jobId : ''),
        j.jobTitle, /*model*/'', /*mp-fl*/'', j.client, j.companyName, j.clientTaxId, j.contactPerson, j.clientEmail,
        j.booker, j.status, j.shootDays, /*fee*/'', /*ot*/'', /*total*/'', j.currency || 'THB', j.leadSource,
        j.confirmationMade ? 'yes' : '', j.signedDocUrl || '', ''];
      if (Array.isArray(j.lines) && j.lines.length) {
        // One row per model with their OWN rate + OT — exactly what billing needs.
        j.lines.forEach(l => {
          const total = (+l.rate || 0) + (+l.ot || 0); grand += (j.currency || 'THB') === 'THB' ? total : 0;
          const row = base.slice();
          row[5] = l.name; row[6] = l.mp ? 'MP' : 'Freelance';
          row[15] = l.rate || 0; row[16] = l.ot || 0; row[17] = total;
          lines.push(row.map(cell).join(','));
        });
      } else {
        const total = jobAmount(j); grand += (j.currency || 'THB') === 'THB' ? total : 0;
        const row = base.slice();
        row[5] = j.model || j.freelance || ''; row[6] = j.model ? 'MP' : (j.freelance ? 'Freelance' : '');
        row[15] = +j.budget || 0; row[16] = otNum(j.overtimeFee) || (j.overtimeFee || ''); row[17] = total;
        lines.push(row.map(cell).join(','));
      }
    });
    lines.push(['', '', '', '', 'TOTAL (THB rows)', '', '', '', '', '', '', '', '', '', '', '', '', Math.round(grand * 100) / 100, 'THB', '', '', '', ''].map(cell).join(','));
    return lines.join('\r\n');
  }
  function downloadCsv(text, filename) {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  // Names a job can carry (single field, comma-joined legacy, or per-model lines).
  const jobNamesOf = j => {
    const out = [];
    if (Array.isArray(j.lines) && j.lines.length) j.lines.forEach(l => l.name && out.push(l.name));
    [j.model, j.freelance].forEach(s => String(s || '').split(/[,\/\n]+/).forEach(t => t.trim() && out.push(t.trim())));
    return out;
  };
  function openExportDrawer() {
    const allNames = [...new Set(jobs.flatMap(jobNamesOf))].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
    el('d-title').textContent = 'Download Job Tracker (Excel)';
    el('drawer-body').innerHTML = `
      <p style="color:var(--grey);font-size:13px;margin-bottom:14px">Downloads a .csv file that opens straight in Excel (Thai text OK) — for billing / ส่งเบิก. Multi-model jobs show one row per model with their own fee + OT.</p>
      <div class="field"><button class="btn" id="ex-filtered" style="width:100%">⬇ What's shown now (current month & filters)</button></div>
      <div class="field"><button class="btn ghost" id="ex-all" style="width:100%">⬇ Everything — all months, all jobs</button></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
      <div class="field"><label>Per model — all of one model's jobs</label>
        <input id="ex-model" list="ex-model-list" placeholder="Start typing a model's name…">
        <datalist id="ex-model-list">${allNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>
      <div class="field"><button class="btn ghost" id="ex-permodel" style="width:100%">⬇ Download this model's jobs</button></div>`;
    const stamp = todayLocal();
    el('ex-filtered').addEventListener('click', () => {
      const scope = el('j-month').value === 'all' ? 'all-months' : el('j-month').value;
      downloadCsv(jobsCsvRows(sortedJobs()), `MP Job Tracker ${scope} ${stamp}.csv`);
    });
    el('ex-all').addEventListener('click', () => {
      const list = jobs.slice().sort((a, b) => (a.jobDate || '').localeCompare(b.jobDate || ''));
      downloadCsv(jobsCsvRows(list), `MP Job Tracker ALL ${stamp}.csv`);
    });
    el('ex-permodel').addEventListener('click', () => {
      const name = el('ex-model').value.trim();
      if (!name) { alert('Type or pick a model name first.'); return; }
      const nn = name.toLowerCase();
      const list = jobs.filter(j => jobNamesOf(j).some(t => t.toLowerCase() === nn))
        .sort((a, b) => (a.jobDate || '').localeCompare(b.jobDate || ''));
      if (!list.length) { alert(`No jobs found for “${name}”.`); return; }
      // For a per-model file, narrow lines-jobs to that model's own fee row.
      const narrowed = list.map(j => (Array.isArray(j.lines) && j.lines.length)
        ? { ...j, lines: j.lines.filter(l => (l.name || '').toLowerCase() === nn) } : j);
      downloadCsv(jobsCsvRows(narrowed), `MP Jobs - ${name} ${stamp}.csv`);
    });
    openDrawer();
  }
  if (el('j-export')) el('j-export').addEventListener('click', openExportDrawer);
  el('j-add').addEventListener('click', () => openJob(null));
  // Sample confirmation — opens an example form (SAMPLE watermark) so bookers can
  // see the layout without filling in a real job. Never touches any data.

  /* ================= 5. JOB DRAWER (view / edit / add / delete) ===== */
  function jobForm(j) {
    const f = (label, key, value, type = 'text') =>
      `<div class="field"><label>${label}</label><input id="d-${key}" type="${type}" value="${esc(value)}"></div>`;
    return `
      ${j && j.source === 'website' ? `<p style="margin:0 0 14px"><span class="badge web">website request</span></p>` : ''}
      <div class="field"><label>Job Title</label><input id="d-jobTitle" value="${esc(j?.jobTitle)}"></div>
      <div class="field two">
        ${f('Job ID (taxed)', 'jobId', j?.jobId || '')}
        ${f('Job ID (non-tax)', 'jobIdNonTax', j?.jobIdNonTax || '')}
      </div>
      <div style="margin:-8px 0 6px;display:flex;gap:16px;font-size:12px;flex-wrap:wrap">
        <button type="button" class="link" id="gen-tax" style="color:var(--teal)">+ Generate C code (taxed)</button>
        <button type="button" class="link" id="gen-nontax" style="color:var(--web)">+ Generate B code (non-tax)</button>
        <button type="button" class="link" id="swap-code" style="color:var(--ink)">⇄ Move C ↔ B</button>
      </div>
      <div id="d-code-warn" class="dup-warn" style="display:none"></div>
      <p style="margin:0 0 16px;font-size:11px;color:var(--grey)">Both codes are free to edit — retype to move a client from Tax (C) to Non-Tax (B), clear a code to free it, or type a freed code onto a new job to reuse it.</p>
      <div class="field two">
        ${f('Booking Date', 'bookingDate', j?.bookingDate || '')}
        ${f('Job Date', 'jobDate', j?.jobDate || '')}
      </div>
      <div class="field">
        <label>Shoot date(s) <span style="font-weight:400;color:var(--grey);font-size:11px">· click the shooting day(s) — they auto-appear on the Schedule so you never re-fill</span></label>
        <div class="mini-cal" id="d-picker"></div>
        <div id="d-picked" class="picked-summary"></div>
      </div>
      <div class="field two">
        ${f('Model (MP)', 'model', j?.model || '')}
        ${f('Freelance', 'freelance', j?.freelance || '')}
      </div>
      <div class="field two">
        <div class="field" style="margin:0"><label>Client</label>
          <input id="d-client" list="client-list" autocomplete="off" value="${esc(j?.client)}" placeholder="start typing — past clients suggest">
          ${clientDatalist()}</div>
        ${f('Booker', 'booker', j?.booker || '')}
      </div>
      <div class="field two">
        <div class="field" style="margin:0"><label>Lead source <span style="font-weight:400;color:var(--declined);font-size:11px">· required</span></label>
          <select id="d-leadSource">
            <option value="">— source —</option>
            ${LEAD_SOURCES.map(s => `<option value="${esc(s)}" ${(j?.leadSource || '') === s ? 'selected' : ''}>${SOURCE_ICON[s] || ''} ${esc(s)}</option>`).join('')}
          </select></div>
        <div class="field" style="margin:0"><label>Client type <span style="font-weight:400;color:var(--declined);font-size:11px">· required</span></label>
          <select id="d-clientCategory">
            <option value="">— type —</option>
            ${CLIENT_CATEGORIES.map(c => `<option value="${esc(c)}" ${(j?.clientCategory || '') === c ? 'selected' : ''}>${CAT_ICON[c] || ''} ${esc(c)}</option>`).join('')}
          </select></div>
      </div>
      <div class="field two money">
        <div class="field" style="margin:0"><label>Budget</label>
          <input id="d-budget" type="text" inputmode="numeric" value="${j?.budget ? withCommas(j.budget) : ''}"></div>
        <div class="field" style="margin:0"><label>Currency</label>
          <select id="d-currency">
            <option value="THB" ${(j?.currency || 'THB') === 'THB' ? 'selected' : ''}>THB ฿</option>
            <option value="USD" ${j?.currency === 'USD' ? 'selected' : ''}>USD $</option>
            <option value="EUR" ${j?.currency === 'EUR' ? 'selected' : ''}>EUR €</option>
            <option value="CNY" ${j?.currency === 'CNY' ? 'selected' : ''}>CNY ¥</option>
          </select></div>
      </div>
      <div class="field" id="d-lines-wrap">
        <label>Per-model fees <span style="font-weight:400;color:var(--grey);font-size:11px">· one row per model when a job confirms several at different rates / OT. When used, it sets the total budget.</span></label>
        <div id="d-lines"></div>
        <div style="display:flex;align-items:center;gap:14px;margin-top:6px">
          <button type="button" class="line-add" id="d-line-add">＋ Add model</button>
          <span id="d-lines-total" style="font-size:12.5px;color:var(--grey)"></span>
        </div>
      </div>
      <div class="field money" style="max-width:220px"><label>Shoot days (fee is often per day)</label>
        <input id="d-shootdays" type="number" min="1" max="10" step="1" value="${j?.shootDays || ''}" placeholder="e.g. 1 or 2"></div>
      ${j && (j.email || j.phone) ? `<div class="field"><label>Contact</label><input value="${esc([j.email, j.phone].filter(Boolean).join('  ·  '))}" readonly></div>` : ''}
      <div class="field"><label>🖊️ Signed confirmation <span style="font-weight:400;color:var(--grey);font-size:11px">· when the client signs &amp; sends it back — upload to
        <a href="https://drive.google.com/drive/folders/1xJO5ZtZsnTlkbzbpsn-y0IbD9sF8-LVG" target="_blank" rel="noopener">📂 JOB CONFIRMATION / 2026</a> (month folder), then paste the file's link here</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="d-signedDocUrl" type="url" placeholder="https://drive.google.com/…" value="${esc(j?.signedDocUrl || '')}" style="flex:1">
          ${j?.signedDocUrl ? `<a href="${esc(j.signedDocUrl)}" target="_blank" rel="noopener" class="btn ghost" style="text-decoration:none;white-space:nowrap">Open ↗</a>` : ''}
        </div></div>
      <div class="field"><label>Assignment description <span style="font-weight:400;color:var(--grey);font-size:11px">· shows on the client confirmation</span></label><textarea id="d-notes" rows="3">${esc(j?.notes)}</textarea></div>
      <div class="field int-note"><label>📝 Internal note <span style="font-weight:400;color:var(--grey);font-size:11px">· team only — never sent to client</span></label><textarea id="d-internalNote" rows="3" placeholder="Reminders for the team: follow-ups, client preferences, anything private…">${esc(j?.internalNote)}</textarea></div>
      <div class="materials-box">
        <div class="materials-head">📷 Photos &amp; videos <span>graphic team</span></div>
        <div class="field two" style="margin-bottom:6px">
          <div class="field" style="margin:0"><label>Status</label>
            <select id="d-materials">
              <option value="" ${!j?.materials ? 'selected' : ''}>Not checked yet</option>
              <option value="searching" ${j?.materials === 'searching' ? 'selected' : ''}>Searching…</option>
              <option value="found" ${j?.materials === 'found' ? 'selected' : ''}>Found ✓</option>
              <option value="done" ${j?.materials === 'done' ? 'selected' : ''}>Done / uploaded</option>
            </select></div>
          <div></div>
        </div>
        <div class="field" style="margin:0"><label>Where / notes (link, folder, comment)</label>
          <input id="d-materialsNote" value="${esc(j?.materialsNote)}" placeholder="e.g. Drive folder, or 'no photos found'"></div>
      </div>
      ${clientDetailsSection(j)}`;
  }

  // The collapsible "Client & confirmation details" block. Opens automatically
  // once a job is confirmed, so bookers know to complete it for the quotation.
  function clientDetailsSection(j) {
    const filled = j ? CLIENT_KEYS.filter(k => j[k]).length : 0;
    const open = j && (j.status === 'confirmed' || filled) ? 'open' : '';
    const groups = CLIENT_SECTIONS.map(([title, fields]) => `
      <div class="cd-group-title">${title}</div>
      <div class="field two">
        ${fields.map(([k, label]) =>
          `<div class="field" style="margin:0"><label>${label}</label><input id="d-${k}" value="${esc(j?.[k])}"></div>`).join('')}
      </div>`).join('');
    return `
      <details class="cd" ${open}>
        <summary>Client &amp; confirmation details ${filled ? `<span class="cd-count">${filled} filled</span>` : '<span class="cd-hint">for quotation / contract</span>'}</summary>
        <div class="cd-body">${groups}${scheduleFeeGroup(j)}</div>
      </details>`;
  }

  // Custom Schedule & fee block: date pickers, clock inputs, work package,
  // and a live overtime calculator.
  function scheduleFeeGroup(j) {
    const val = k => esc(j?.[k]);
    const startDate = j?.shootStart || (isISODate(j?.jobDate) ? j.jobDate : '');
    const pkgOptions = ['<option value="">— select —</option>']
      .concat(Object.entries(PACKAGES).map(([k, p]) =>
        `<option value="${k}" ${j?.workPackage === k ? 'selected' : ''}>${p.label}</option>`)).join('');
    const fld = (label, inner) => `<div class="field" style="margin:0"><label>${label}</label>${inner}</div>`;
    return `
      <div class="cd-group-title">Schedule &amp; fee</div>
      <div class="field two">
        ${fld('Date of Shoot (Start)', `<input id="d-shootStart" type="date" value="${esc(startDate)}">`)}
        ${fld('Date of Shoot (End)', `<input id="d-shootEnd" type="date" value="${val('shootEnd')}">`)}
      </div>
      <div class="field two">
        ${fld('Time of Shoot (Start)', `<input id="d-timeStart" type="time" value="${val('timeStart')}">`)}
        ${fld('Time of Shoot (End)', `<input id="d-timeEnd" type="time" value="${val('timeEnd')}">`)}
      </div>
      <div class="field two">
        ${fld('Work Package', `<select id="d-workPackage">${pkgOptions}</select>`)}
        ${fld('Contracted hours', `<input id="d-contractHours" type="number" step="0.5" min="0" value="${val('contractHours')}" placeholder="any hours, e.g. 6">`)}
      </div>
      <div class="field two">
        ${fld('Break (hours)', `<input id="d-breakHours" type="number" step="0.5" min="0" value="${val('breakHours')}">`)}
        <div></div>
      </div>
      <div class="field two">
        <div class="field" style="margin:0"><label>Overtime Rate (THB / hour)</label>
          <input id="d-overtimeRate" type="number" min="0" value="${val('overtimeRate')}"></div>
        ${fld('No. of Shoot', `<input id="d-noOfShoot" value="${val('noOfShoot')}">`)}
      </div>
      <div class="ot-box" id="ot-summary">Choose a work package and enter times to calculate overtime.</div>
      <div class="field two">
        <div class="field" style="margin:0"><label>Overtime Fee — amount or condition</label>
          <input id="d-overtimeFee" type="text" value="${val('overtimeFee')}" placeholder="e.g. 9375 — or 1,250/hour after 13 hours"></div>
        ${fld('Payment Term', `<input id="d-paymentTerm" value="${val('paymentTerm')}">`)}
      </div>
      <div class="field"><label>Remark</label><input id="d-remark" value="${val('remark')}"></div>`;
  }

  // Overtime billing rule (from the confirmation terms):
  // under 30 min → not charged; over 30 min → counts as a full hour.
  function billOvertime(rawHours) {
    if (rawHours <= 0) return 0;
    const whole = Math.floor(rawHours);
    return whole + ((rawHours - whole) >= 0.5 ? 1 : 0);
  }
  const toMinutes = t => { const [h, m] = (t || '').split(':').map(Number); return (h * 60 + (m || 0)); };

  function recalcOvertime() {
    const box = el('ot-summary');
    if (!box) return;
    const t1 = el('d-timeStart').value, t2 = el('d-timeEnd').value;
    // Allowed on-set hours = the Contracted hours field (flexible, any value).
    const contracted = parseFloat(el('d-contractHours') ? el('d-contractHours').value : '') || 0;
    if (!contracted) { box.textContent = 'Enter the contracted hours (and times) to calculate overtime.'; box.className = 'ot-box'; return; }
    if (!t1 || !t2) { box.textContent = `${contracted}h contracted — enter start & end time to calculate overtime.`; box.className = 'ot-box'; return; }

    let elapsed = (toMinutes(t2) - toMinutes(t1)) / 60;
    if (elapsed < 0) elapsed += 24;                 // shoot ran past midnight
    const brk = parseFloat(el('d-breakHours').value) || 0;
    const allowed = contracted + brk;
    const otHours = billOvertime(elapsed - allowed);
    const rate = parseFloat(el('d-overtimeRate').value) || 0;
    const fee = otHours * rate;

    // Fill the fee only from real numbers — never overwrite a CONDITION the
    // booker typed ("1,250/hour after 13 hours") unless we computed a fee.
    const feeBox = el('d-overtimeFee');
    const feeIsCondition = feeBox.value.trim() && !/^[\d,]+(\.\d+)?$/.test(feeBox.value.trim());
    if (otHours > 0 && rate > 0) feeBox.value = fee;
    else if (otHours === 0 && !feeIsCondition) feeBox.value = '';

    box.className = 'ot-box' + (otHours > 0 ? ' has-ot' : '');
    box.innerHTML = `On set <b>${elapsed.toFixed(1)}h</b> · allowed <b>${allowed}h</b> `
      + `(${contracted}h contracted + break ${brk}h) → overtime <b>${otHours}h</b>`
      + (rate > 0 ? ` × ฿${rate.toLocaleString()} = <b>฿${fee.toLocaleString()}</b>`
                  : (otHours > 0 ? ' — enter an overtime rate' : ''));
  }

  function wireOvertimeCalc() {
    const pkgEl = el('d-workPackage');
    if (!pkgEl) return;
    pkgEl.addEventListener('change', () => {
      const p = PACKAGES[pkgEl.value];
      // A preset pre-fills the contracted hours + default break; "Custom" leaves them for typing.
      if (p && p.hours != null && el('d-contractHours')) el('d-contractHours').value = p.hours;
      if (p && !el('d-breakHours').value) el('d-breakHours').value = p.brk;
      recalcOvertime();
    });
    ['d-timeStart', 'd-timeEnd', 'd-breakHours', 'd-overtimeRate', 'd-contractHours'].forEach(id =>
      el(id).addEventListener('input', recalcOvertime));
    recalcOvertime();
  }

  function collectJob() {
    const data = {
      jobTitle: el('d-jobTitle').value, jobId: el('d-jobId').value, jobIdNonTax: el('d-jobIdNonTax').value,
      bookingDate: el('d-bookingDate').value, jobDate: el('d-jobDate').value,
      model: el('d-model').value, freelance: el('d-freelance').value,
      client: el('d-client').value, booker: el('d-booker').value,
      budget: el('d-budget').value, currency: el('d-currency') ? el('d-currency').value : 'THB',
      shootDays: el('d-shootdays') ? el('d-shootdays').value : '',
      shootDates: el('d-picker') ? pickedList() : [],
      notes: el('d-notes').value,
      internalNote: el('d-internalNote') ? el('d-internalNote').value : '',
      materials: el('d-materials') ? el('d-materials').value : '',
      materialsNote: el('d-materialsNote') ? el('d-materialsNote').value : '',
      whtMode: el('d-whtMode') ? el('d-whtMode').value : '',
    };
    CLIENT_KEYS.forEach(k => { const e = el('d-' + k); if (e) data[k] = e.value; });
    data.lines = collectJobLines();
    return data;
  }
  const lineNum = v => parseFloat(String(v == null ? '' : v).replace(/[,\s฿]/g, '')) || 0;
  function collectJobLines() {
    return [...document.querySelectorAll('#d-lines .line-row')].map(r => ({
      name: r.querySelector('.ln-name').value.trim(),
      mp: r.querySelector('.ln-type').value === 'mp',
      rate: lineNum(r.querySelector('.ln-rate').value),
      ot: lineNum(r.querySelector('.ln-ot').value),
    })).filter(l => l.name || l.rate || l.ot);
  }
  function lineRowHtml(l) {
    l = l || {};
    return `<div class="line-row">
      <input class="ln-name" placeholder="Model name" value="${esc(l.name || '')}">
      <select class="ln-type"><option value="mp"${l.mp !== false ? ' selected' : ''}>MP</option><option value="fl"${l.mp === false ? ' selected' : ''}>Freelance</option></select>
      <input class="ln-rate" inputmode="numeric" placeholder="Rate ฿" value="${l.rate ? withCommas(l.rate) : ''}">
      <input class="ln-ot" inputmode="numeric" placeholder="OT ฿" value="${l.ot ? withCommas(l.ot) : ''}">
      <button type="button" class="ln-del" title="remove">×</button>
    </div>`;
  }
  function updateLinesTotal() {
    const lines = collectJobLines();
    const total = lines.reduce((s, l) => s + l.rate + l.ot, 0);
    const t = el('d-lines-total');
    if (t) t.textContent = lines.length ? `Total ฿${withCommas(total)} · ${lines.length} model${lines.length > 1 ? 's' : ''}` : '';
    const bud = el('d-budget');
    if (bud) {
      if (lines.length) { bud.value = withCommas(total); bud.readOnly = true; bud.style.opacity = '.6'; bud.title = 'Auto — sum of per-model fees'; }
      else { bud.readOnly = false; bud.style.opacity = '1'; bud.title = ''; }
    }
  }
  function wireJobLines(j) {
    const wrap = el('d-lines'); if (!wrap) return;
    (j && Array.isArray(j.lines) ? j.lines : []).forEach(l => wrap.insertAdjacentHTML('beforeend', lineRowHtml(l)));
    const add = el('d-line-add');
    if (add) add.addEventListener('click', () => { wrap.insertAdjacentHTML('beforeend', lineRowHtml({ mp: true })); updateLinesTotal(); wrap.lastElementChild.querySelector('.ln-name').focus(); });
    wrap.addEventListener('click', e => { const d = e.target.closest('.ln-del'); if (d) { d.closest('.line-row').remove(); updateLinesTotal(); } });
    wrap.addEventListener('input', updateLinesTotal);
    updateLinesTotal();
  }

  // Open the client confirmation for a job — shared by the drawer's Confirmation
  // button AND the per-row 👁 preview in the tracker. Handles the per-model fee
  // lines and the legacy shared-code grouping. Type ('tax'/'nontax') is inferred
  // from the job's codes when not given.
  // Enrich a job for the confirmation (per-model fee table, legacy code-grouping)
  // and resolve the form type — shared by the 👁 preview and the silent Drive save.
  function confirmationDocData(data, type) {
    // The last form type used (incl. International) is remembered on the job —
    // but only while it still MATCHES the job's code family. A job moved C→B
    // must flip to Non-Tax even if 'tax' was remembered (Tawa: B1110 kept +VAT).
    const hasC = !!(data.jobId && !/b\s?\d/i.test(data.jobId));
    const hasB = !!(data.jobIdNonTax || /b\s?\d/i.test(data.jobId || ''));
    let saved = ['tax', 'nontax', 'intl'].includes(data.confType) ? data.confType : '';
    if (saved === 'tax' && !hasC) saved = '';
    if (saved === 'nontax' && !hasB && hasC) saved = '';
    if (!type && saved) type = saved;
    if (!type) type = hasC ? 'tax' : (hasB ? 'nontax' : 'tax');
    // ONE job holding several models with their own rate/OT → per-model fee table.
    if (Array.isArray(data.lines) && data.lines.length > 1) {
      data.modelFees = data.lines.map(l => ({
        model: l.name,
        fee: (+l.rate || 0) + (+l.ot || 0),
        currency: data.currency || 'THB',
      }));
    } else {
      // Legacy: multiple SEPARATE job records sharing one code → one confirmation
      // listing every model + their fee.
      const pc = jj => { const m = String(jj.jobId || jj.jobIdNonTax || '').match(/([CB])\s?(\d{3,})/i); return m ? m[1].toUpperCase() + m[2] : ''; };
      const myCode = pc(data);
      if (myCode) {
        const group = jobs.filter(x => pc(x) === myCode);
        if (group.length > 1) {
          data.modelFees = group.map(x => ({
            model: (x.id === data.id ? data.model : (x.model || x.freelance)) || (x.model || x.freelance),
            fee: (x.id === data.id ? data.budget : x.budget),
            currency: (x.id === data.id ? data.currency : x.currency) || 'THB',
          }));
        }
      }
    }
    return { data, type };
  }
  function openConfirmationDoc(rawData, rawType) {
    const { data, type } = confirmationDocData(rawData, rawType);
    // Remember the chosen form type on the job (see confirmationDocData).
    if (data.id && data.confType !== type && role !== 'designer') {
      api('/api/jobs/' + data.id, { method: 'PATCH', body: JSON.stringify({ confType: type }) })
        .then(() => { const jj = jobs.find(x => x.id === data.id); if (jj) jj.confType = type; })
        .catch(() => {});
    }
    // Ploy sees money like the bookers now (Lisa 2026-08-20) — full form for all.
    const doc = MPConfirmation.open(data, type, {});
    if (doc) addConfDocTools(doc, data, type);
  }
  // The confirmation as spreadsheet rows [label, value] — Aim keys jobs into her
  // system from a Google SHEET in Chrome (old workflow); numbers via the SAME
  // calc() the printed form uses, so they can never disagree.
  function confSheetRows(job, type) {
    const c = MPConfirmation.calc(job, type);
    const rows = [];
    const add = (a, b) => { rows.push([a, b == null ? '' : String(b)]); };
    rows.push(['JOB DETAILS', '']);
    add('Job Code', job.jobId || job.jobIdNonTax || '');
    add('Assignment Title', job.jobTitle || '');
    add('Client / Company', job.companyName || job.client || '');
    add('Model Name(s)', (Array.isArray(job.lines) && job.lines.length
      ? job.lines.map(l => l.name) : [job.model, job.freelance]).filter(Boolean).join(', '));
    add('Media Usage', job.mediaUsage || '');
    add('Period of Usage', job.periodOfUsage || '');
    add('Country/ies of Use', job.countryOfUse || '');
    add('Shooting Location', job.shootLocation || '');
    add('Date of Shoot', (job.shootStart || '') + (job.shootEnd && job.shootEnd !== job.shootStart ? ' → ' + job.shootEnd : ''));
    add('Time of Shoot', (job.timeStart || '') + (job.timeEnd ? ' – ' + job.timeEnd : ''));
    add('Contracted Hours', job.contractHours || '');
    add('Booker', job.booker || '');
    rows.push(['PAYMENT', '']);
    if (Array.isArray(job.modelFees) && job.modelFees.length > 1)
      job.modelFees.forEach(mf => add('   ' + (mf.model || ''), c.cash(c.num(mf.fee))));
    add('Fee (excl. VAT)', c.cash(c.fee));
    add('Overtime', c.otDisplay || '—');
    add('Subtotal', c.cash(c.subtotal));
    if (c.v.vat) add('VAT 7%', c.cash(c.vat));
    add('TOTAL PAYMENT AMOUNT', c.cash(c.total));
    if (c.whtOn) { add('Less Withholding Tax 3%', '-' + c.cash(c.wht)); add('NET AMOUNT TO TRANSFER', c.cash(c.netPay)); }
    add('Payment Term', job.paymentTerm || '');
    add('Remark', job.remark || '');
    return rows;
  }
  // POST the confirmation to Lisa's Apps Script → Google SHEET + PDF copy filed
  // under JOB CONFIRMATION → <year> → <n.MONTH>, overwriting older versions.
  // --- exact-form PDF, rendered by the booker's own browser -----------------
  // Google's HTML→Doc converter mangled the form (screen hints leaked into the
  // PDF, the layout collapsed — Lisa: must be the exact app form). html2pdf
  // captures the REAL rendered form in a hidden iframe instead.
  let h2pLoad = null;
  function ensureHtml2pdf() {
    if (window.html2pdf) return Promise.resolve();
    if (!h2pLoad) h2pLoad = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'js/vendor/html2pdf.bundle.min.js';
      s.onload = res;
      s.onerror = () => { h2pLoad = null; rej(new Error('html2pdf load failed')); };
      document.head.appendChild(s);
    });
    return h2pLoad;
  }
  async function confPdfBase64(html) {
    await ensureHtml2pdf();
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-11000px;top:0;width:794px;height:1200px;border:0';
    document.body.appendChild(frame);
    try {
      const d = frame.contentDocument;
      d.open(); d.write(html); d.close();
      await new Promise(r => setTimeout(r, 700));           // let logo/signature load
      d.querySelectorAll('.print-btn,.hint,.conf-tools').forEach(x => x.remove());
      const uri = await window.html2pdf().set({
        margin: [8, 8, 10, 8],
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2.5, useCORS: true, windowWidth: 794 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] },
      }).from(d.body).outputPdf('datauristring');
      return String(uri).split(',')[1] || '';
    } finally { frame.remove(); }
  }
  async function driveUploadConfirmation(job, type, html, onStatus) {
    if (!appSettings.driveUploadUrl) return;
    let pdfBase64 = '';
    try { pdfBase64 = await confPdfBase64(html || MPConfirmation.render(job, type)); }
    catch (_) {}   // without it the script falls back to its own (table) version
    fetch(appSettings.driveUploadUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        key: appSettings.driveUploadKey || '',   // script rejects uploads without it
        filename: driveDocName(job) || (job.jobTitle || 'Job Confirmation'),
        jobDate: job.jobDate || '',
        code: job.jobId || job.jobIdNonTax || '',
        pdfBase64: pdfBase64,                       // the EXACT rendered form
        html: MPConfirmation.renderDrive ? MPConfirmation.renderDrive(job, type) : '',  // fallback only
        grid: MPConfirmation.sheetGrid ? MPConfirmation.sheetGrid(job, type) : null,    // form-styled Sheet
        sheet: confSheetRows(job, type),            // fallback for old script versions
      }),
    }).then(r => r.json())
      .then(r => onStatus && onStatus(!!(r && r.ok), r || {}))
      .catch(() => onStatus && onStatus(false, {}));
  }
  // Tawa: editing a job must overwrite its Drive copies right away.
  function autoDriveSave(jobRec) {
    try {
      if (!jobRec || !jobRec.confirmationMade || !appSettings.driveUploadUrl) return;
      const { data, type } = confirmationDocData({ ...jobRec });
      const html = MPConfirmation.render(data, type);
      driveUploadConfirmation(data, type, html, ok => { if (ok) toast('☁ Confirmation updated in Drive'); });
    } catch (_) {}
  }
  // Drive filename in the team's own convention: <code>-<Title>_<Model, Model>.
  function driveDocName(job) {
    if (!job) return '';
    const clean = s => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const code = clean(job.jobId || job.jobIdNonTax).replace(/\s+/g, '');
    const models = (Array.isArray(job.lines) && job.lines.length
      ? job.lines.map(l => l.name) : [job.model || job.freelance])
      .filter(Boolean).map(clean).join(', ');
    const title = clean(job.jobTitle) || 'Job';
    return [code, title].filter(Boolean).join('-') + (models ? '_' + models : '');
  }
  // Floating toolbar inside the confirmation window: ⬇ Word file + ☁ Drive status.
  // The Drive save posts the rendered HTML to Lisa's Apps Script webhook, which
  // stores it as a GOOGLE DOC in the confirmations folder (Admin opens it right
  // in Chrome — no PDF, no copy-paste). Skips silently until the URL is set up.
  function addConfDocTools(doc, job, type) {
    try {
      const d = doc.win.document;
      const bar = d.createElement('div');
      bar.className = 'conf-tools';
      bar.style.cssText = 'position:fixed;top:10px;right:10px;display:flex;gap:8px;z-index:9999;font-family:system-ui';
      const mk = label => {
        const b = d.createElement('button'); b.textContent = label;
        b.style.cssText = 'padding:6px 12px;border:1px solid #bbb;border-radius:8px;background:#fff;cursor:pointer;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.18)';
        bar.appendChild(b); return b;
      };
      // Browser print dialog → "Save as PDF"; the tab title is already the
      // code-first filename, so the saved PDF is named right automatically.
      mk('⬇ PDF').onclick = () => doc.win.print();
      mk('⬇ Word').onclick = () => {
        const blob = new Blob(['﻿' + doc.html], { type: 'application/msword' });
        const a = d.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (doc.title || 'Job Confirmation') + '.doc';
        d.body.appendChild(a); a.click(); a.remove();
      };
      if (appSettings.driveUploadUrl) {
        const st = mk('☁ saving to Drive…'); st.disabled = true;
        driveUploadConfirmation(job, type, doc.html, (ok, resp) => {
          st.textContent = ok ? '☁ in Drive ✓' : '☁ Drive failed';
          // Once the Drive copy exists, one tap sends Admin the link in LINE:
          // opens LINE's share screen with the message ready — pick Aim, send.
          if (ok && (resp.sheetUrl || resp.pdfUrl)) {
            const line = mk('📤 LINE');
            line.title = 'Copies the message + opens LINE. On a computer where LINE doesn\'t open, just paste (Cmd+V) into the chat — it\'s already copied.';
            line.onclick = () => {
              const msg = '📄 ' + (driveDocName(job) || doc.title) + '\n'
                + (resp.sheetUrl ? resp.sheetUrl : '')
                + (resp.pdfUrl ? '\nPDF: ' + resp.pdfUrl : '');
              // Desktop browsers often can't launch the LINE app — copy first,
              // so pasting into LINE desktop always works (Tawa's case).
              try { (doc.win.navigator.clipboard || navigator.clipboard).writeText(msg); } catch (_) {}
              const old = line.textContent;
              line.textContent = '📋 copied — paste in LINE';
              setTimeout(() => { line.textContent = old; }, 4000);
              doc.win.open('https://line.me/R/share?text=' + encodeURIComponent(msg), '_blank');
            };
          }
        });
      }
      const style = d.createElement('style');
      style.textContent = '@media print{.conf-tools{display:none!important}}';
      d.head.appendChild(style);
      d.body.appendChild(bar);
    } catch (_) {}
  }

  // openJob(id)            → edit an existing job
  // openJob(null)          → blank Add-job form
  // openJob(null, prefill) → Add-job form pre-filled from a casting (see jobPrefillFromEntry)
  function openJob(id, prefill) {
    const j = id ? jobs.find(x => x.id === id) : null;
    const src = j || prefill || null;   // values shown in the form
    const codeOnly = !!(prefill && prefill._codeOnly);
    el('d-title').textContent = j ? (j.jobTitle || 'Job') : (prefill && !codeOnly ? 'New job from casting' : 'Add job');
    const confirmUi = j ? `
        <select id="d-form-type" title="Confirmation form">
          ${MPConfirmation.types.map(t => `<option value="${t.key}" ${t.key === MPConfirmation.defaultType(j) ? 'selected' : ''}>${t.label}</option>`).join('')}
        </select>
        <select id="d-whtMode" title="Withholding tax 3% on the confirmation — Auto shows it for THB clients only (foreign clients can't issue a Thai WHT certificate)">
          <option value="" ${!j?.whtMode ? 'selected' : ''}>WHT 3%: Auto (THB only)</option>
          <option value="on" ${j?.whtMode === 'on' ? 'selected' : ''}>WHT 3%: Show</option>
          <option value="off" ${j?.whtMode === 'off' ? 'selected' : ''}>WHT 3%: Hide (foreign)</option>
        </select>
        <button class="btn ghost" id="d-confirm-doc" title="Open the client confirmation. Tick the 📄 in the tracker yourself once it's actually created/sent.">Confirmation</button>` : '';

    el('drawer-body').innerHTML = (prefill && !codeOnly ? '<p style="margin:0 0 14px;color:var(--teal);font-size:12.5px">Pre-filled from the casting — add budget & client, then Create.</p>' : '')
      + (codeOnly ? `<p style="margin:0 0 14px;color:var(--teal);font-size:12.5px">Code <b>${esc(prefill.jobId || prefill.jobIdNonTax)}</b> is free — fill in the job details, then Create.</p>` : '')
      + jobForm(src) + `
      <div class="drawer-actions">
        <button class="btn" id="d-save">${j ? 'Save changes' : 'Create job'}</button>
        ${confirmUi}
        ${j && canSeeMoney() ? '<button class="link revenue-only" id="d-to-income" style="color:var(--teal)" title="This isn\'t a model booking — move it to Other Income (studio rental, commission, sale…)">→ Move to Other Income</button>' : ''}
        ${j ? '<button class="link" id="d-delete" style="color:var(--declined)">Delete</button>' : ''}
      </div>`;

    wireOvertimeCalc();   // live overtime calculator in the Schedule & fee block
    wireJobLines(j);      // per-model fee rows (multi-model job at different rates + OT)

    // Shoot-date picker: pre-select the job's existing shoot dates and render.
    pickedDates = new Set((src && Array.isArray(src.shootDates)) ? src.shootDates : []);
    pickerMonth = (pickedList()[0] || (isISODate(src?.jobDate) ? src.jobDate : todayLocal())).slice(0, 7);
    onPickerChange = null;
    if (el('d-picker')) renderDatePicker();

    // Budget field: add thousands separators as you type (no spinner arrows).
    const bud = el('d-budget');
    if (bud) bud.addEventListener('input', () => { bud.value = withCommas(bud.value); });

    // Remembered clients: picking / typing a known client fills their company details.
    const cli = el('d-client');
    if (cli) {
      cli.addEventListener('change', () => autofillClient(cli.value));   // fires on datalist pick or blur
      cli.addEventListener('input', () => { if (clientMemory(cli.value)) autofillClient(cli.value); });
    }

    // Auto-tag: a NEW job defaults its Booker to whoever is logged in (bookers
    // only; managers pick manually). Casting-prefill keeps the casting's booker.
    if (!j) {
      const mine = sessionStorage.getItem('mp_admin_bookername') || '';
      if (mine && el('d-booker') && !el('d-booker').value) el('d-booker').value = mine;
    }

    // Running-code generator buttons
    el('gen-tax').addEventListener('click', async () => {
      try { el('d-jobId').value = (await api('/api/next-code')).tax; } catch (_) { alert('Could not fetch the next code — check the connection and try again.'); }
      checkCodeDup();
    });
    el('gen-nontax').addEventListener('click', async () => {
      try { el('d-jobIdNonTax').value = (await api('/api/next-code')).nonTax; } catch (_) { alert('Could not fetch the next code — check the connection and try again.'); }
      checkCodeDup();
    });
    // Move a code between Tax (C) and Non-Tax (B) — for when a client switches
    // invoice type. Swaps the two fields' contents in one click.
    el('swap-code').addEventListener('click', () => {
      const c = el('d-jobId').value, b = el('d-jobIdNonTax').value;
      el('d-jobId').value = b;
      el('d-jobIdNonTax').value = c;
      checkCodeDup();
    });
    // Live guard: warn if a typed code is already used by a DIFFERENT job — so a
    // booker never double-creates or re-uses a taken code by accident. (Overtime /
    // usage lines of the SAME job are fine — those legitimately share a code.)
    const baseTitle = s => String(s || '').toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    function checkCodeDup() {
      const warn = el('d-code-warn'); if (!warn) return;
      const mine = j ? j.id : null;
      const myBase = baseTitle(el('d-jobTitle') ? el('d-jobTitle').value : '');
      const codes = [el('d-jobId').value, el('d-jobIdNonTax').value]
        .map(s => { const m = String(s).match(/([CB])\s?(\d{3,})/i); return m ? (m[1].toUpperCase() + m[2]) : ''; })
        .filter(Boolean);
      const clashes = [];
      codes.forEach(code => {
        jobs.forEach(x => {
          if (x.id === mine) return;
          const xc = String(x.jobId || x.jobIdNonTax || '').match(/([CB])\s?(\d{3,})/i);
          const xcode = xc ? (xc[1].toUpperCase() + xc[2]) : '';
          if (xcode !== code) return;
          // same base job (multi-model / OT / usage line) → OK, not a clash
          if (baseTitle(x.jobTitle) === myBase && myBase) return;
          clashes.push(`${esc(code)} is already used by “${esc(x.jobTitle || '(untitled)')}” (${esc(x.model || x.freelance || '?')})`);
        });
      });
      if (clashes.length) { warn.style.display = 'block'; warn.innerHTML = '⚠ ' + [...new Set(clashes)].slice(0, 3).join('<br>⚠ ') + '<br><span style="font-weight:400">Use a fresh code (Generate) unless this is an overtime/usage line of the same job.</span>'; }
      else warn.style.display = 'none';
    }
    ['d-jobId', 'd-jobIdNonTax', 'd-jobTitle'].forEach(id => { const e = el(id); if (e) e.addEventListener('input', checkCodeDup); });
    checkCodeDup();
    // Printable confirmation form (uses whatever is currently in the form)
    // Designer (Ploy) can open the confirmation to check country of airing etc.,
    // but WITHOUT the fees/payment section (money stays hidden from her).
    // Open the confirmation for the current job (with multi-model fee grouping).
    // Generating/downloading does NOT mark the job — the 📄 tick means "actually
    // created/sent" and the booker sets it themselves in the tracker.
    if (j) el('d-confirm-doc').addEventListener('click', () => {
      openConfirmationDoc({ ...j, ...collectJob() }, el('d-form-type').value);
    });

    el('d-save').addEventListener('click', async () => {
      const data = collectJob();
      if (!data.jobTitle.trim()) { alert('Please add a job title.'); return; }
      // Lead source is required on NEW jobs (CRM tracking). Existing jobs aren't forced.
      if (!j && !(data.leadSource || '').trim()) {
        alert('Please pick a Lead source — where did this client come from?');
        if (el('d-leadSource')) el('d-leadSource').focus();
        return;
      }
      if (!j && !(data.clientCategory || '').trim()) {
        alert('Please pick a Client type — Fashion, Commercial, Film & TV, Event organizer…');
        if (el('d-clientCategory')) el('d-clientCategory').focus();
        return;
      }
      // Guard against double-clicks: two fast clicks on Create fired two POSTs
      // and made duplicate jobs (with duplicate codes).
      const saveBtn = el('d-save');
      if (saveBtn.disabled) return;
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      let saved;
      try {
        if (j) {
          const r = await api('/api/jobs/' + j.id, { method: 'PATCH', body: JSON.stringify(data) });
          Object.assign(j, r.job); saved = j;
          // Tawa: an edited job overwrites its confirmation copies in Drive.
          autoDriveSave(saved);
        } else {
          const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify(data) });
          jobs.unshift(r.job); saved = r.job;
          // If this job came from a casting, mark it created + link it, and decline the
          // other held days of that option so the model is freed up (same as confirming).
          if (prefill && prefill._fromScheduleId) {
            const e = schedule.find(x => x.id === prefill._fromScheduleId);
            await api('/api/schedule/' + prefill._fromScheduleId, { method: 'PATCH', body: JSON.stringify({ jobCreated: true, jobRef: saved.id }) }).catch(() => {});
            if (e) { e.jobCreated = true; e.jobRef = saved.id; }
            if (e && e.holdGroup) {
              const siblings = schedule.filter(x => x.holdGroup === e.holdGroup && x.id !== e.id && x.status !== 'declined');
              for (const s of siblings) {
                await api('/api/schedule/' + s.id, { method: 'PATCH', body: JSON.stringify({ status: 'declined' }) }).catch(() => {});
                s.status = 'declined';
              }
            }
          }
        }
        await syncShootDates(saved);   // put the shoot date(s) on the Schedule automatically
        buildFilters(); renderJobs(); renderSchedule(); closeDrawer();
      } catch (err) {
        if (err.message !== 'unauthorized') alert('Could not save the job: ' + err.message);
      } finally {
        saveBtn.disabled = false; saveBtn.textContent = j ? 'Save changes' : 'Create job';
      }
    });
    if (j) el('d-delete').addEventListener('click', async () => {
      if (!confirm('Delete this job permanently?')) return;
      try {
        await api('/api/jobs/' + j.id, { method: 'DELETE' });
        jobs = jobs.filter(x => x.id !== j.id);
        // The server cascades away this job's shoot entries — mirror that locally.
        schedule = schedule.filter(e => e.jobRef !== j.id);
        buildFilters(); renderJobs(); renderSchedule(); closeDrawer();
      } catch (err) { if (err.message !== 'unauthorized') alert('Could not delete: ' + err.message); }
    });

    // Move a non-booking entry (studio rental, commission, a sale) OUT of the Job
    // Tracker and INTO Other Income — where it counts toward net profit. Creates the
    // income record from the job's amount/date, then removes the job from the tracker.
    if (j && canSeeMoney() && el('d-to-income')) el('d-to-income').addEventListener('click', async () => {
      const label = (j.jobTitle || 'this job');
      if (!confirm(`Move “${label}” to Other Income?\n\nIt leaves the Job Tracker and its amount counts as net income instead. You can edit the type/details after.`)) return;
      // Guess the type from the title (studio/rental → rental), else "other".
      const t = /studio|rental|rent\b/i.test(label) ? 'rental' : 'other';
      const src = [j.jobTitle, j.client].filter(Boolean).join(' · ');
      const payload = {
        date: j.jobDate || todayLocal(),
        kind: t,
        amount: jobAmount(j) || 0,
        currency: j.currency || 'THB',
        source: src,
        note: 'Moved from Job Tracker' + (j.jobIdNonTax || j.jobId ? ' (' + (j.jobIdNonTax || j.jobId) + ')' : ''),
      };
      try {
        await api('/api/income', { method: 'POST', body: JSON.stringify(payload) });
        await api('/api/jobs/' + j.id, { method: 'DELETE' });
        jobs = jobs.filter(x => x.id !== j.id);
        schedule = schedule.filter(e => e.jobRef !== j.id);   // server cascades shoot entries
        buildFilters(); renderJobs(); renderSchedule(); closeDrawer();
        toast('Moved to Other Income →');
      } catch (e) { alert('Could not move: ' + (e.message || e)); }
    });

    openDrawer();
  }

  // Put a job's shoot date(s) onto the Schedule automatically (as confirmed shooting
  // entries linked back to the job), so a booker never re-fills the calendar. Re-syncs
  // on every save: removes the job's old shoot entries, then adds one per current date.
  async function syncShootDates(job) {
    if (!job) return;
    const dates = Array.isArray(job.shootDates) ? job.shootDates : [];
    // Remove existing schedule entries linked to this job whose date is no longer set.
    const existing = schedule.filter(e => e.jobRef === job.id);
    for (const e of existing) {
      if (!dates.includes(e.date)) {
        try { await api('/api/schedule/' + e.id, { method: 'DELETE' }); } catch (_) {}
        schedule = schedule.filter(x => x.id !== e.id);
      }
    }
    // Add a shooting entry for any date that doesn't already have one.
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const modelStr = job.model || job.freelance || '';
    for (const dt of dates) {
      if (existing.some(e => e.date === dt)) continue;      // already linked to this job
      // Don't double-fill: if this model already has a job/shooting entry that day, LINK
      // that one to the job instead of creating a duplicate card.
      const clash = schedule.find(e => e.date === dt && e.jobRef !== job.id
        && norm(e.models) === norm(modelStr)
        && (e.job || e.stage === 'shooting' || e.status === 'confirmed'));
      if (clash) {
        try { await api('/api/schedule/' + clash.id, { method: 'PATCH', body: JSON.stringify({ jobRef: job.id, stage: 'shooting', jobCreated: true }) }); } catch (_) {}
        clash.jobRef = job.id; clash.stage = 'shooting'; clash.jobCreated = true;
        continue;
      }
      const body = {
        date: dt, models: modelStr, subject: job.jobTitle || '',
        job: job.jobTitle || '(job)', booker: job.booker || '', status: 'confirmed',
        stage: 'shooting', jobCreated: true, jobRef: job.id,
      };
      try {
        const r = await api('/api/schedule', { method: 'POST', body: JSON.stringify(body) });
        if (r.entry) schedule.push(r.entry);
      } catch (_) {}
    }
  }

  /* ================= 6. SCHEDULE ================= */
  function filteredSchedule() {
    const month = el('s-month').value;
    const booker = el('s-booker').value;
    const term = el('s-search').value.trim().toLowerCase();
    return schedule.filter(e => {
      if (month !== 'all' && e.month !== month) return false;
      if (booker === '__untagged__') { if (e.booker) return false; }
      else if (booker && e.booker !== booker) return false;
      if (term) {
        const hay = [e.models, e.casting, e.fitting, e.option, e.job, e.booker, e.subject, e.shortlist, e.priority, e.note].join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }

  let scheduleView = 'calendar';               // 'calendar' | 'board' | 'day' | 'list'
  let dayDate = todayLocal();   // the day shown in Day view AND the Board
  let boardAll = false;         // Board: false = one day at a time, true = whole pipeline
  let calMonth = null;          // 'YYYY-MM' shown in the Calendar view (nav is free of data)
  const firstLine = t => String(t || '').split('\n')[0].trim();
  // Shift a 'YYYY-MM' string by n months — lets the calendar reach any future month/year.
  function shiftMonth(ym, n) {
    let [y, m] = ym.split('-').map(Number);
    m += n;
    y += Math.floor((m - 1) / 12);
    m = ((m - 1) % 12 + 12) % 12 + 1;
    return `${y}-${String(m).padStart(2, '0')}`;
  }

  // --- "TOMORROW" REMINDER: models a booker must notify 1 day ahead ---
  // Bookers see only their own; Director/Admin see everyone's. Tick "Sent" as you go.
  function renderReminders() {
    const box = el('s-reminders');
    if (!box) return;
    const tomorrow = addDays(todayLocal(), 1);
    const mine = sessionStorage.getItem('mp_admin_bookername') || '';
    const isMgr = canSeeMoney();
    // Only CASTINGS and JOBS need a heads-up — options are tentative "maybe" notes
    // and don't count until they confirm. Skip declined/postponed too.
    let items = schedule.filter(e => e.date === tomorrow
      && e.status !== 'declined' && e.status !== 'postponed'
      && e.models && e.models.trim()
      && (e.casting || e.fitting || e.job));
    if (!isMgr && mine) items = items.filter(e => (e.booker || '').toLowerCase() === mine.toLowerCase());
    if (!items.length) {
      box.innerHTML = '';
      const l = el('rem-launcher'); if (l) l.style.display = 'none';
      const p = el('rem-pop'); if (p) p.style.display = 'none';
      return;
    }

    const pending = items.filter(e => !e.notified);
    const label = new Date(tomorrow + 'T00:00:00Z')
      .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const rows = items.map(e => {
      const kind = e.job ? '<span class="rem-kind job">JOB</span>' : e.fitting ? '<span class="rem-kind cast">FITTING</span>' : '<span class="rem-kind cast">CASTING</span>';
      const detail = e.subject || firstLine(e.job || e.fitting || e.casting) || '(no details)';
      const time = e.timeStart ? ' · ' + e.timeStart + (e.timeEnd ? '–' + e.timeEnd : '') : '';
      const who = (isMgr && e.booker) ? ` · <b>${esc(e.booker)}</b>` : '';
      return `<div class="rem-row ${e.notified ? 'sent' : ''}" data-id="${e.id}">
        <span class="rem-model">${esc(e.models)}</span>
        <span class="rem-what">${kind} ${esc(detail)}${time}${who}</span>
        <span class="rem-actions">
          <button class="rem-btn rem-notify" data-id="${e.id}">✉ Send</button>
          <label class="rem-sent-toggle"><input type="checkbox" class="rem-sent" data-id="${e.id}" ${e.notified ? 'checked' : ''}> Sent</label>
        </span>
      </div>`;
    }).join('');
    const done = pending.length === 0;
    const head = done
      ? `✅ All ${items.length} model${items.length > 1 ? 's' : ''} notified for tomorrow (${label})`
      : `🔔 Tomorrow (${label}) — <span class="rem-badge">${pending.length} to notify</span>
         <span style="font-weight:400;color:var(--grey);font-size:12px">send each model a heads-up</span>`;
    box.innerHTML = `<div class="rem-panel ${done ? 'done' : ''}">
      <div class="rem-head">${head}</div>${rows}</div>`;

    // Show the floating bubble + update its badge (count of models still to notify).
    const launcher = el('rem-launcher'); if (launcher) launcher.style.display = 'block';
    const badge = el('rem-count');
    if (badge) { badge.textContent = pending.length; badge.classList.toggle('zero', pending.length === 0); }

    box.querySelectorAll('.rem-notify').forEach(b =>
      b.addEventListener('click', () => { const p = el('rem-pop'); if (p) p.style.display = 'none'; notifyModel(b.dataset.id); }));
    box.querySelectorAll('.rem-sent').forEach(c =>
      c.addEventListener('change', async () => {
        const id = c.dataset.id, val = c.checked ? tomorrow : '';
        await api('/api/schedule/' + id, { method: 'PATCH', body: JSON.stringify({ notified: val }) });
        const e = schedule.find(x => x.id === id); if (e) e.notified = val;
        renderReminders();
      }));
  }
  // Open/close the floating reminder pop-up.
  (function wireReminderBubble() {
    const tog = el('rem-toggle'), pop = el('rem-pop'), close = el('rem-close');
    if (!tog || !pop) return;
    tog.addEventListener('click', () => { pop.style.display = pop.style.display === 'none' ? 'block' : 'none'; });
    if (close) close.addEventListener('click', () => { pop.style.display = 'none'; });
  })();

  // Show whichever schedule view is active.
  function renderSchedule() {
    renderReminders();
    el('s-calendar').style.display = scheduleView === 'calendar' ? 'block' : 'none';
    el('s-board').style.display = scheduleView === 'board' ? 'block' : 'none';
    el('s-day').style.display = scheduleView === 'day' ? 'block' : 'none';
    el('s-history').style.display = scheduleView === 'history' ? 'block' : 'none';
    el('s-list').style.display = scheduleView === 'list' ? 'block' : 'none';
    el('s-summary').style.display = scheduleView === 'summary' ? 'block' : 'none';
    el('s-empty').style.display = 'none';
    if (scheduleView === 'calendar') renderCalendar();
    else if (scheduleView === 'board') renderBoard();
    else if (scheduleView === 'day') renderDay();
    else if (scheduleView === 'history') renderHistory();
    else if (scheduleView === 'summary') renderScheduleSummary();
    else renderList();
  }

  /* ===== Declined / Postponed history — bookers can bring an entry back ===== */
  function renderHistory() {
    const month = el('s-month').value;
    const booker = el('s-booker').value;
    const term = el('s-search').value.trim().toLowerCase();
    const match = e => {
      if (month !== 'all' && e.month !== month) return false;   // follow the month selector
      if (booker && e.booker !== booker) return false;
      if (term && ![e.subject, e.models, e.casting, e.fitting, e.option, e.job, e.shortlist, e.note, e.booker].join(' ').toLowerCase().includes(term)) return false;
      return true;
    };
    // newest date first
    const rows = schedule.filter(e => (e.status === 'declined' || e.status === 'postponed') && match(e))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const typeLabel = e => catLabel(e);
    const body = rows.map(e => {
      const detail = e.subject || firstLine(entryText(e)) || '—';
      const pill = e.status === 'declined'
        ? '<span class="hist-pill declined">Declined</span>'
        : '<span class="hist-pill postponed">Postponed</span>';
      const pp = e.status === 'postponed'
        ? `<div class="hist-pp">Postpone to: <input type="date" class="hist-ppdate" data-id="${e.id}" value="${esc(isISODate(e.postponeDate) ? e.postponeDate : '')}">${e.postponeDate && !isISODate(e.postponeDate) ? ` <span style="color:var(--grey)">(${esc(e.postponeDate)})</span>` : ''}</div>`
        : '';
      return `<tr class="row" data-id="${e.id}">
        <td>${esc(e.date) || '—'}</td>
        <td><span class="hist-type">${typeLabel(e)}</span> ${esc(detail)}${pp}</td>
        <td>${esc(e.models) || '—'}</td>
        <td>${esc(e.booker) || '—'}</td>
        <td>${pill}</td>
        <td class="r"><button class="link hist-back" data-id="${e.id}" style="color:var(--teal);font-weight:600">↩ Bring back</button>
          <button class="link hist-edit" data-id="${e.id}">Edit</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">Nothing declined or postponed. Anything you decline is kept here so you can bring it back.</td></tr>';

    el('s-history').innerHTML = `
      <p class="board-hint">Everything you decline or postpone is kept here — nothing is deleted. Bring one back to make it active again (all its details are still filled in).</p>
      <div class="card"><table>
        <thead><tr><th>Date</th><th>What</th><th>Model</th><th>Booker</th><th>Status</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>`;

    el('s-history').querySelectorAll('.hist-back').forEach(b =>
      b.addEventListener('click', async () => {
        const e = schedule.find(x => x.id === b.dataset.id); if (!e) return;
        // Bring back the WHOLE hold, not just this one day.
        const members = e.holdGroup ? schedule.filter(x => x.holdGroup === e.holdGroup) : [e];
        for (const s of members) {
          try { await api('/api/schedule/' + s.id, { method: 'PATCH', body: JSON.stringify({ status: 'open', stage: '' }) }); s.status = 'open'; s.stage = ''; }
          catch (_) {}
        }
        buildFilters(); renderSchedule();
      }));
    el('s-history').querySelectorAll('.hist-edit').forEach(b =>
      b.addEventListener('click', () => editScheduleEntry(b.dataset.id, () => { renderSchedule(); })));
    el('s-history').querySelectorAll('.hist-ppdate').forEach(inp =>
      inp.addEventListener('change', async () => {
        const e = schedule.find(x => x.id === inp.dataset.id); if (!e) return;
        await api('/api/schedule/' + e.id, { method: 'PATCH', body: JSON.stringify({ postponeDate: inp.value }) });
        e.postponeDate = inp.value;
      }));
  }

  /* ===== Schedule BOARD — drag-and-drop pipeline (Ness's request) ===== */
  const BOARD_STAGES = [
    ['shooting', 'Confirmed / Shooting', '#22a06b'],
    ['priority', 'Priority', '#e67e22'],
    ['shortlist', 'Shortlisted', '#a855f7'],
    ['fitting', 'Fitting', '#6366f1'],
    ['casting', 'Casting', '#b8860b'],
    ['option', 'Options', '#0ea5e9'],
    ['goandsee', 'Go & See', '#0d9488'],
    ['waiting_payment', 'Waiting payment', '#f97316'],
    ['postponed', 'Postponed', '#a9701a'],
    ['declined', 'Declined', '#c74436'],
  ];
  const STAGE_KEYS = BOARD_STAGES.map(s => s[0]);
  const stageColor = k => { const s = BOARD_STAGES.find(x => x[0] === k); return s ? s[2] : '#ccc'; };
  const isGoSee = t => /go\s*(?:&|and)?\s*see/i.test(String(t || ''));
  // Where a booking sits if it has no explicit stage yet — inferred from its type tags.
  function deriveStage(e) {
    if (e.priority) return 'priority';         // admin task (visa/flight/vacation) = hard "don't book" block; wins over any stage
    if (STAGE_KEYS.includes(e.stage)) return e.stage;
    if (e.jobCreated || e.job) return 'shooting';
    if (e.shortlist) return 'shortlist';
    if (e.fitting) return 'fitting';
    if (e.casting && isGoSee(e.casting)) return 'goandsee';   // "Go & See" is its own column
    if (e.option) return 'option';
    if (e.casting) return 'casting';
    return 'casting';
  }
  // The ONE category an entry belongs to — shared by Month, stats AND Board so they never
  // disagree. MUST mirror deriveStage exactly (same order): a Priority admin task is a hard
  // "don't book" block that wins over any stage; otherwise an explicit board stage wins;
  // otherwise the furthest-along type tag wins.
  function schedCat(e) {
    if (e.priority) return 'prio';             // admin-task block — wins over any stage
    if (STAGE_KEYS.includes(e.stage)) {
      return (e.stage === 'shooting' || e.stage === 'waiting_payment' || e.stage === 'complete') ? 'job'
        : e.stage === 'shortlist' ? 'short' : e.stage === 'fitting' ? 'fit'
        : e.stage === 'option' ? 'opt' : e.stage === 'priority' ? 'prio'
        : e.stage === 'goandsee' ? 'gosee' : e.stage === 'casting' ? 'cast' : 'note';
    }
    if (e.job || e.jobCreated) return 'job';
    if (e.shortlist) return 'short';
    if (e.fitting) return 'fit';
    if (e.casting) return isGoSee(e.casting) ? 'gosee' : 'cast';
    if (e.option) return 'opt';
    return 'note';
  }
  // Human label for an entry's ONE category — history, copy, conflicts, notify all
  // use this so no view ever names the same entry two different things.
  const CAT_LABELS = { prio: 'Priority', short: 'Shortlist', job: 'Job', fit: 'Fitting', cast: 'Casting', gosee: 'Go & See', opt: 'Option', note: 'Entry' };
  function catLabel(e) { return CAT_LABELS[schedCat(e)] || 'Entry'; }
  // One card per booking: multi-day holds (same holdGroup) collapse into a single card.
  function boardCards() {
    const booker = el('s-booker').value;
    const term = el('s-search').value.trim().toLowerCase();
    const byKey = {}; const cards = [];
    schedule.forEach(e => {
      if (booker && e.booker !== booker) return;
      if (term && ![e.subject, e.models, e.casting, e.fitting, e.option, e.job, e.shortlist, e.note, e.booker].join(' ').toLowerCase().includes(term)) return;
      const key = e.holdGroup || e.id;
      if (byKey[key]) {
        byKey[key].ids.push(e.id);
        if (e.date) byKey[key].dates.push(e.date);
        if (STAGE_KEYS.includes(e.stage)) byKey[key].stage = e.stage;
        return;
      }
      const c = { key, rep: e, ids: [e.id], dates: e.date ? [e.date] : [], stage: STAGE_KEYS.includes(e.stage) ? e.stage : null };
      byKey[key] = c; cards.push(c);
    });
    cards.forEach(c => { c.stage = c.stage || deriveStage(c.rep); c.dates.sort(); });
    return cards;
  }
  const cardTimeKey = c => { const t = (c.rep.timeStart || '').trim(); return t || '99:99'; };
  function bcardHtml(c) {
    const e = c.rep;
    const d = c.dates;
    const dateStr = d.length ? (d.length > 1 ? fmtNice(d[0]) + '–' + fmtNice(d[d.length - 1]) : fmtNice(d[0])) : (e.date || '');
    const subj = e.subject || firstLine(e.job || e.option || e.casting || e.shortlist || e.note || '') || 'Booking';
    const hold = c.ids.length > 1 ? `<span class="b-hold">🔒 ${c.ids.length} days</span>` : '';
    const time = e.timeStart ? `<span class="b-time">🕐 ${esc(e.timeStart)}${e.timeEnd ? '–' + esc(e.timeEnd) : ''}</span>` : '';
    const pp = (e.status === 'postponed' && e.postponeDate) ? `<div class="b-pp">→ postponed to ${esc(e.postponeDate)}</div>` : '';
    // Related stages of the SAME booking (other days) — so a casting card shows its
    // shooting/fitting dates too, and you never think a shoot date is "missing".
    let plan = '';
    if (e.planGroup) {
      const label = { shooting: '🎬 Shoot', fitting: '👗 Fit', casting: '🎥 Cast', goandsee: '👀 Go&See', option: '🔖 Option', shortlist: '★ Short', priority: '⚑ Prio' };
      const sibs = schedule.filter(x => x.planGroup === e.planGroup && x.date !== e.date && x.status !== 'declined')
        .map(x => ({ st: deriveStage(x), d: x.date })).filter(x => x.d);
      const seen = {}; const parts = [];
      sibs.sort((a, b) => (a.d || '').localeCompare(b.d || '')).forEach(x => {
        const k = x.st + x.d; if (seen[k]) return; seen[k] = 1;
        parts.push(`${label[x.st] || '•'} ${fmtNice(x.d)}`);
      });
      if (parts.length) plan = `<div class="b-plan">↳ also: ${parts.join(' · ')}</div>`;
    }
    return `<div class="bcard" draggable="true" data-key="${esc(c.key)}" style="border-left-color:${stageColor(c.stage)}">
      <div class="b-subj">${esc(subj)}</div>
      ${e.models ? `<div class="b-models">${esc(e.models)}</div>` : ''}
      ${pp}${plan}
      <div class="b-meta">${time}<span>${esc(dateStr)}</span>${hold}${e.booker ? `<span class="b-book">${esc(e.booker)}</span>` : ''}</div>
    </div>`;
  }
  function renderBoard() {
    let cards = boardCards();
    if (!boardAll) cards = cards.filter(c => c.dates.includes(dayDate));   // just this day
    const groups = {}; STAGE_KEYS.forEach(k => groups[k] = []);
    const lastKey = 'declined';   // catch any stray stage
    // Declined / Postponed have their own columns; everything else goes by its stage.
    const colOf = c => c.rep.status === 'declined' ? 'declined'
      : c.rep.status === 'postponed' ? 'postponed' : c.stage;
    cards.forEach(c => { (groups[colOf(c)] || groups[lastKey]).push(c); });
    // Order each column by time — earliest first, so bookers see what's first / next.
    STAGE_KEYS.forEach(k => groups[k].sort((a, b) =>
      parseTimeMin(a.rep.timeStart) - parseTimeMin(b.rep.timeStart) || (a.dates[0] || '').localeCompare(b.dates[0] || '')));
    const cols = BOARD_STAGES.map(([k, label, color]) => {
      const list = groups[k];
      if (k === 'priority' && !list.length) return '';   // Priority column only appears when there's an admin task that day
      const inner = list.map(bcardHtml).join('') || '<div class="board-empty">—</div>';
      return `<div class="board-col" data-stage="${k}">
        <div class="board-col-head"><span class="dot" style="background:${color}"></span>${esc(label)}<span class="cnt">${list.length}</span></div>
        <div class="board-cards">${inner}</div>
      </div>`;
    }).join('');
    const d = new Date(dayDate + 'T00:00:00');
    const nice = isNaN(d) ? dayDate : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const nav = `<div class="day-nav board-nav">
        <button class="link" id="b-prev">◀ Prev day</button>
        <b style="min-width:210px;text-align:center">${boardAll ? 'All days' : esc(nice)}</b>
        <button class="link" id="b-next">Next day ▶</button>
        <button class="link" id="b-today">Today</button>
        <input type="date" id="b-jump" value="${dayDate}" style="padding:6px 8px;border:1px solid var(--line);border-radius:8px" ${boardAll ? 'disabled' : ''}>
        <button class="seg-btn ${boardAll ? 'active' : ''}" id="b-all" style="border:1px solid var(--line);border-radius:8px;margin-left:auto">${boardAll ? '✓ ' : ''}All days</button>
      </div>`;
    el('s-board').innerHTML = nav +
      `<p class="board-hint">Drag a booking between columns as its status changes — drop it in <b>Declined</b> or <b>Postponed</b> to set it aside (nothing is deleted), or drag it back out to bring it back. A multi-day hold moves as one. Tap a card to open it.</p>
       <div class="board">${cols}</div>`;
    const go = days => { dayDate = addDays(dayDate, days); renderBoard(); };
    el('b-prev').addEventListener('click', () => go(-1));
    el('b-next').addEventListener('click', () => go(1));
    el('b-today').addEventListener('click', () => { dayDate = todayLocal(); boardAll = false; renderBoard(); });
    el('b-jump').addEventListener('change', ev => { dayDate = ev.target.value; boardAll = false; renderBoard(); });
    el('b-all').addEventListener('click', () => { boardAll = !boardAll; renderBoard(); });
    wireBoardDnD();
  }
  function wireBoardDnD() {
    let dragKey = null;
    el('s-board').querySelectorAll('.bcard').forEach(card => {
      card.addEventListener('dragstart', ev => {
        dragKey = card.dataset.key; card.classList.add('dragging');
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', card.dataset.key); } catch (_) {}
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging'); dragKey = null;
        el('s-board').querySelectorAll('.board-col').forEach(c => c.classList.remove('drop-hot'));
      });
      card.addEventListener('click', () => {
        const key = card.dataset.key;
        // Open ONLY this booking — prefer the entry on the day currently shown.
        const e = schedule.find(x => (x.holdGroup || x.id) === key && x.date === dayDate)
              || schedule.find(x => (x.holdGroup || x.id) === key);
        if (e) openDay(e.date, e.id);
      });
    });
    el('s-board').querySelectorAll('.board-col').forEach(col => {
      col.addEventListener('dragover', ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; col.classList.add('drop-hot'); });
      col.addEventListener('dragleave', () => col.classList.remove('drop-hot'));
      col.addEventListener('drop', ev => {
        ev.preventDefault(); col.classList.remove('drop-hot');
        const key = dragKey || (ev.dataTransfer && ev.dataTransfer.getData('text/plain'));
        if (key && col.dataset.stage) moveCardToStage(key, col.dataset.stage);
      });
    });
  }
  // Drag targets:
  //   → Declined / Postponed column = set that status (keeps all its details)
  //   → any normal column, from Declined/Postponed = bring it back (status open) + that stage
  //   → any normal column, already active = just move its stage
  async function moveCardToStage(key, target) {
    const entries = schedule.filter(e => (e.holdGroup || e.id) === key);
    if (!entries.length) return;
    // A Priority admin task (visa/flight/vacation) is a "don't book" block — it can't be
    // dragged into a booking column (that's what wrongly gave ALIYA a shooting stage).
    if (entries[0].priority && !['priority', 'declined', 'postponed'].includes(target)) {
      renderBoard();
      alert('This is a Priority admin task — the model is blocked that day, so it can’t go into a booking column. Open the card and change its Type if it should be a booking.');
      return;
    }
    const cur = entries[0].status;
    let patch;
    if (target === 'declined') patch = { status: 'declined' };
    else if (target === 'postponed') patch = { status: 'postponed' };
    else { patch = { stage: target }; if (cur === 'declined' || cur === 'postponed') patch.status = 'open'; }
    entries.forEach(e => {
      if (patch.status !== undefined) e.status = patch.status;
      if (patch.stage !== undefined) e.stage = patch.stage;
    });
    renderBoard();
    for (const e of entries) {
      try { await api('/api/schedule/' + e.id, { method: 'PATCH', body: JSON.stringify(patch) }); } catch (_) {}
    }
  }

  // Per-booker breakdown of castings / options / jobs — for the selected month
  // and for the full year.
  function renderScheduleSummary() {
    if (!canSeeMoney()) { el('s-summary').innerHTML = ''; return; }   // Director/Admin only
    const month = el('s-month').value;   // 'YYYY-MM' or 'all'
    const year = (month !== 'all' ? month : (distinct(schedule.map(s => s.month)).sort().reverse()[0] || '')).slice(0, 4);

    const table = (title, entries) => {
      const bookers = distinct(entries.map(e => e.booker || '(untagged)')).sort();
      // A multi-day hold is ONE option spread over several days (same holdGroup),
      // so count it ONCE — never 5× for a 5-day hold. Singles count by their own id.
      // Classification uses schedCat — the same rule as the calendar/board — so an
      // entry counts in exactly ONE column and the reports always reconcile.
      const count = (es, cat) => new Set(es.filter(e => schedCat(e) === cat || (cat === 'cast' && schedCat(e) === 'gosee')).map(e => e.holdGroup || e.id)).size;
      const totalOf = es => new Set(es.map(e => e.holdGroup || e.id)).size;
      let cT = 0, fT = 0, oT = 0, jT = 0, sT = 0, pT = 0, tT = 0;
      const rows = bookers.map(b => {
        const es = entries.filter(e => (e.booker || '(untagged)') === b);
        const c = count(es, 'cast'), f = count(es, 'fit'), o = count(es, 'opt'), j = count(es, 'job'),
          s = count(es, 'short'), p = count(es, 'prio');
        const total = totalOf(es);
        cT += c; fT += f; oT += o; jT += j; sT += s; pT += p; tT += total;
        return `<tr class="row"><td class="model-cell">${esc(b)}</td>
          <td class="num">${j}</td><td class="num">${s}</td><td class="num">${f}</td><td class="num">${c}</td>
          <td class="num">${o}</td><td class="num">${p}</td><td class="num"><b>${total}</b></td></tr>`;
      }).join('');
      return `<h3 style="margin:18px 0 8px;font-size:15px">${esc(title)}</h3>
        <div class="card"><table>
          <thead><tr><th>Booker</th><th class="num">Jobs</th><th class="num">Shortlist</th>
            <th class="num">Fitting</th><th class="num">Castings</th><th class="num">Options</th><th class="num">Priority</th><th class="num">Total leads</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="empty">No entries.</td></tr>'}
            <tr style="background:#fafafa;font-weight:700"><td>All bookers</td>
              <td class="num">${jT}</td><td class="num">${sT}</td><td class="num">${fT}</td><td class="num">${cT}</td>
              <td class="num">${oT}</td><td class="num">${pT}</td><td class="num">${tT}</td></tr>
          </tbody></table></div>`;
    };

    const monthEntries = month !== 'all' ? schedule.filter(e => e.month === month) : [];
    const yearEntries = schedule.filter(e => (e.month || '').startsWith(year));
    el('s-summary').innerHTML =
      (month !== 'all' ? table(monthLabel(month), monthEntries) : '') +
      table(year + ' — full year', yearEntries);
  }

  // The single colour/type of an entry, for the Day view + chips.
  function entryType(e) {
    const c = schedCat(e);
    return c === 'gosee' ? 'cast' : c;   // calendar colours Go&See as a casting
  }
  function entryText(e) {
    return e.priority || e.shortlist || e.job || e.fitting || e.option || e.casting || e.note || '';
  }

  // --- DAY view: an hourly grid like Google Calendar ----------------
  const DAY_START_H = 6, DAY_END_H = 23, HOUR_PX = 48;   // 6am–11pm
  function toMin(t) { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1] * 60 + +m[2]) : null; }

  function renderDay() {
    const booker = el('s-booker').value;
    const term = el('s-search').value.trim().toLowerCase();
    const dayEntries = schedule.filter(e => {
      if (e.date !== dayDate) return false;
      if (booker && e.booker !== booker) return false;
      if (term) return [e.subject, e.models, e.casting, e.fitting, e.option, e.job, e.shortlist, e.priority, e.note, e.booker].join(' ').toLowerCase().includes(term);
      return true;
    });

    const timed = [], allday = [];
    dayEntries.forEach(e => (toMin(e.timeStart) != null ? timed : allday).push(e));

    // Column layout for overlapping timed entries.
    timed.sort((a, b) => toMin(a.timeStart) - toMin(b.timeStart));
    assignColumns(timed);

    const d = new Date(dayDate + 'T00:00:00');
    const nice = isNaN(d) ? dayDate : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    // hour labels
    let hoursHtml = '';
    for (let h = DAY_START_H; h <= DAY_END_H; h++) {
      const lbl = h === 12 ? '12 PM' : h > 12 ? (h - 12) + ' PM' : h + ' AM';
      hoursHtml += `<div class="day-hour">${lbl}</div>`;
    }
    const gridHeight = (DAY_END_H - DAY_START_H + 1) * HOUR_PX;

    // timed event blocks
    const events = timed.map(e => {
      const start = toMin(e.timeStart);
      let end = toMin(e.timeEnd);
      if (end == null || end <= start) end = start + 60;   // default 1h
      const top = (start - DAY_START_H * 60) / 60 * HOUR_PX;
      const height = Math.max(22, (end - start) / 60 * HOUR_PX - 2);
      const w = 100 / e._cols, left = e._col * w;
      const time = esc(e.timeStart + (e.timeEnd ? '–' + e.timeEnd : ''));
      return `<div class="day-event ev-${entryType(e)}" data-id="${e.id}"
        style="top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${w}% - 4px)">
        <div class="et">${time} ${esc(e.booker) || ''}</div>
        <div class="et">${esc(e.subject || firstLine(entryText(e)))}</div>
        <div class="em">${esc(e.models) || ''}</div>
      </div>`;
    }).join('');

    const alldayHtml = allday.length
      ? allday.map(e => `<span class="adchip ev-${entryType(e)}" data-id="${e.id}" title="${esc(e.models)}">${esc(e.booker ? e.booker + ': ' : '')}${esc(e.subject || e.models || firstLine(entryText(e)))}</span>`).join('')
      : '<span style="color:var(--grey);font-size:12px">No untimed entries</span>';

    el('s-day').innerHTML = `
      <div class="day-nav">
        <button id="d-prev">‹</button>
        <button id="d-today">Today</button>
        <button id="d-next">›</button>
        <span class="d-title">${nice}</span>
        <input type="date" id="d-jump" value="${dayDate}" style="padding:6px 8px;border:1px solid var(--line);border-radius:8px">
      </div>
      <div class="day-allday"><span class="lbl">All-day / no time</span>${alldayHtml}</div>
      <div class="day-grid">
        <div class="day-hours">${hoursHtml}</div>
        <div class="day-col" style="height:${gridHeight}px">${events}</div>
      </div>
      <div class="cal-legend" style="margin-top:10px">
        <span class="lg-prio">Priority</span><span class="lg-short">Shortlist</span>
        <span class="lg-fit">Fitting</span><span class="lg-cast">Casting</span><span class="lg-opt">Options</span><span class="lg-job">Jobs</span>
      </div>`;

    const go = (days) => { dayDate = addDays(dayDate, days); renderDay(); };
    el('d-prev').addEventListener('click', () => go(-1));
    el('d-next').addEventListener('click', () => go(1));
    el('d-today').addEventListener('click', () => { dayDate = todayLocal(); renderDay(); });
    el('d-jump').addEventListener('change', ev => { dayDate = ev.target.value; renderDay(); });
    el('s-day').querySelectorAll('.day-event, .adchip').forEach(el2 =>
      el2.addEventListener('click', () => editScheduleEntry(el2.dataset.id)));
  }

  // Assign side-by-side columns to overlapping timed entries.
  function assignColumns(items) {
    let cluster = [], clusterEnd = -1;
    const flush = c => {
      const colEnd = [];
      c.forEach(it => {
        const s = toMin(it.timeStart), e = Math.max(toMin(it.timeEnd) || s + 60, s + 60);
        let col = colEnd.findIndex(end => end <= s);
        if (col === -1) { col = colEnd.length; colEnd.push(e); } else colEnd[col] = e;
        it._col = col;
      });
      c.forEach(it => it._cols = colEnd.length);
    };
    for (const it of items) {
      const s = toMin(it.timeStart);
      if (cluster.length && s >= clusterEnd) { flush(cluster); cluster = []; clusterEnd = -1; }
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, Math.max(toMin(it.timeEnd) || s + 60, s + 60));
    }
    if (cluster.length) flush(cluster);
  }

  // Make sure a 'YYYY-MM' exists as an option in a month <select> (for empty
  // future months the arrows can reach), then leave it selectable.
  function ensureMonthOption(sel, ym) {
    if (ym && ym !== 'all' && ![...sel.options].some(o => o.value === ym)) {
      const o = document.createElement('option');
      o.value = ym; o.textContent = monthLabel(ym);
      sel.appendChild(o);
    }
  }

  // --- CALENDAR view: a real month grid -----------------------------
  function renderCalendar() {
    // The calendar has its OWN month cursor so you can page to ANY month/year —
    // even empty future ones — to plan ahead. Default to the CURRENT month on load.
    if (!calMonth) calMonth = todayLocal().slice(0, 7);
    const STAT_DEFS = [
      ['Jobs', e => schedCat(e) === 'job', 'lg-job'],
      ['Shortlist', e => schedCat(e) === 'short', 'lg-short'],
      ['Fitting', e => schedCat(e) === 'fit', 'lg-fit'],
      ['Casting', e => schedCat(e) === 'cast', 'lg-cast'],
      ['Go & See', e => schedCat(e) === 'gosee', 'lg-gosee'],
      ['Options', e => schedCat(e) === 'opt', 'lg-opt'],
      ['Priority', e => schedCat(e) === 'prio', 'lg-prio'],
    ];
    // "All months" can't fit a 12-month day grid — show a year-at-a-glance instead:
    // every month that has activity, with its totals. Click a month to open it.
    if (el('s-month').value === 'all') {
      const bkr = el('s-booker').value;
      const months = distinct(schedule.map(s => s.month)).filter(Boolean).sort().reverse();
      const inScope = e => (!bkr || (bkr === '__untagged__' ? !e.booker : e.booker === bkr))
        && (e.status !== 'declined' || e.autoDeclined);
      const rowFor = mo => {
        const me = schedule.filter(e => e.month === mo && inScope(e));
        const c = pick => new Set(me.filter(pick).map(e => e.holdGroup || e.id)).size;
        const pills = STAT_DEFS.map(([label, pick, cls]) =>
          `<span class="yo-pill"><span class="cal-stat-dot ${cls}"></span><b>${c(pick)}</b> ${label}</span>`).join('');
        return `<div class="yo-row" data-month="${mo}"><span class="yo-mon">${monthLabel(mo)}</span><div class="yo-pills">${pills}</div></div>`;
      };
      // All-year totals across every month (respects the booker filter) — one card per category.
      const yearScope = schedule.filter(inScope);
      const yTot = pick => new Set(yearScope.filter(pick).map(e => e.holdGroup || e.id)).size;
      const statCards = STAT_DEFS.map(([label, pick, cls]) =>
        `<div class="stat"><div class="n">${yTot(pick)}</div><div class="l"><span class="cal-stat-dot ${cls}"></span> ${label}</div></div>`).join('');
      el('s-calendar').innerHTML = `
        <div class="cal-nav"><p class="cal-title">All months · year overview</p>
          <span style="color:var(--grey);font-size:12.5px">totals across every month · click a month to open its calendar</span></div>
        <div class="stats" style="margin-bottom:14px">${statCards}</div>
        <div class="yo-list">${months.map(rowFor).join('') || '<div class="empty" style="padding:24px">No entries yet.</div>'}</div>`;
      el('s-calendar').querySelectorAll('.yo-row').forEach(r =>
        r.addEventListener('click', () => { el('s-month').value = r.dataset.month; calMonth = r.dataset.month; renderCalendar(); }));
      return;
    }
    // Keep the month dropdown locked in step with the grid (so they never disagree).
    ensureMonthOption(el('s-month'), calMonth);
    el('s-month').value = calMonth;
    const month = calMonth;

    // Which entries fall on which day (respecting the booker + search filters,
    // but NOT the month dropdown — the arrows drive the month here).
    const booker = el('s-booker').value;
    const term = el('s-search').value.trim().toLowerCase();
    const byDate = {};
    schedule.forEach(e => {
      if (e.month !== month || !e.date) return;
      if (booker === '__untagged__') { if (e.booker) return; }
      else if (booker && e.booker !== booker) return;
      if (term) {
        const hay = [e.models, e.casting, e.fitting, e.option, e.job, e.booker, e.subject, e.shortlist, e.priority, e.note].join(' ').toLowerCase();
        if (!hay.includes(term)) return;
      }
      (byDate[e.date] = byDate[e.date] || []).push(e);
    });

    const [y, m] = month.split('-').map(Number);
    const startDow = new Date(y, m - 1, 1).getDay();   // 0 = Sunday
    const daysInMonth = new Date(y, m, 0).getDate();
    const todayStr = todayLocal();
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let cells = '';
    for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${month}-${String(d).padStart(2, '0')}`;
      const chips = [];
      // One chip per entry: its subject (or the first line of its details),
      // coloured by the entry's main type.
      (byDate[ds] || []).forEach(e => {
        const t = entryType(e);
        const prefix = t === 'prio' ? '⚑ ' : t === 'short' ? '★ ' : '';
        chips.push([t, prefix + (e.subject || firstLine(entryText(e))), e.booker || '', e.status]);
      });
      // Order within a day. Priority (admin tasks — visa / work permit / vacation)
      // shows FIRST so bookers see it before booking a model that day and can work
      // around those hours; then: Work → Shortlist → Casting → Fitting → Options → Note.
      // Declined/expired entries always sink to the very bottom.
      const CAL_RANK = { prio: 0, job: 1, short: 2, cast: 3, fit: 4, opt: 5, note: 6 };
      chips.sort((a, b) => {
        const da = a[3] === 'declined' ? 1 : 0, db = b[3] === 'declined' ? 1 : 0;
        if (da !== db) return da - db;
        return (CAL_RANK[a[0]] != null ? CAL_RANK[a[0]] : 9) - (CAL_RANK[b[0]] != null ? CAL_RANK[b[0]] : 9);
      });
      const shown = chips.slice(0, 4).map(([c, t, bk, st]) =>
        `<span class="cal-chip ${c}${st === 'declined' ? ' declined' : ''}">${bk ? `<span class="cal-who">${esc(bk)}</span> ` : ''}${esc(firstLine(t))}</span>`).join('');
      const more = chips.length > 4 ? `<div class="cal-more">+${chips.length - 4} more</div>` : '';
      cells += `<div class="cal-cell ${ds === todayStr ? 'today' : ''}" data-date="${ds}">
        <div class="cal-date">${d}</div>${shown}${more}</div>`;
    }

    // Month stats — a true monthly-activity tally. Options auto-decline once their
    // date passes, so the old "exclude all declined" rule made every past month read
    // 0 options. We now keep expired holds (autoDeclined) and count them — only a
    // genuine manual rejection is left out. So each month shows its real totals like
    // the current one. Multi-day holds dedupe by holdGroup.
    const monthEntries = schedule.filter(e => e.month === month
      && (!booker || (booker === '__untagged__' ? !e.booker : e.booker === booker))
      && (e.status !== 'declined' || e.autoDeclined));
    const countType = pick => new Set(monthEntries.filter(pick).map(e => e.holdGroup || e.id)).size;
    const statBar = STAT_DEFS.map(([label, pick, cls]) =>
      `<div class="cal-stat"><span class="cal-stat-dot ${cls}"></span><b>${countType(pick)}</b> ${label}</div>`).join('');

    el('s-calendar').innerHTML = `
      <div class="cal-nav">
        <button class="link cal-prev" title="Previous month">‹</button>
        <p class="cal-title">${monthLabel(month)}</p>
        <button class="link cal-next" title="Next month">›</button>
        <button class="link cal-today" title="Jump to this month">Today</button>
      </div>
      <div class="cal-stats">${statBar}</div>
      <div class="cal">${DOW.map(d => `<div class="cal-dow">${d}</div>`).join('')}${cells}</div>
      <div class="cal-legend">
        <span class="lg-prio">Priority (admin task)</span>
        <span class="lg-short">Shortlist (held)</span>
        <span class="lg-fit">Fitting</span>
        <span class="lg-cast">Casting</span>
        <span class="lg-opt">Options</span>
        <span class="lg-job">Jobs</span>
      </div>`;

    const goMonth = (target) => { calMonth = target; renderCalendar(); };
    el('s-calendar').querySelector('.cal-prev').addEventListener('click', () => goMonth(shiftMonth(month, -1)));
    el('s-calendar').querySelector('.cal-next').addEventListener('click', () => goMonth(shiftMonth(month, 1)));
    el('s-calendar').querySelector('.cal-today').addEventListener('click', () => goMonth(todayLocal().slice(0, 7)));

    // Click a day → jump straight to that day's Board (drag bookings through stages).
    // Scouters are read-only, so day-click does nothing for them.
    if (role !== 'scouter') el('s-calendar').querySelectorAll('.cal-cell[data-date]').forEach(c =>
      c.addEventListener('click', () => { dayDate = c.dataset.date; boardAll = false; setScheduleView('board'); }));
  }

  // --- LIST view: day-by-day rows -----------------------------------
  function renderList() {
    const list = filteredSchedule();
    el('s-empty').style.display = list.length ? 'none' : 'block';
    const byDate = {}, order = [];
    list.forEach(e => {
      const d = e.date || 'No date';
      if (!byDate[d]) { byDate[d] = []; order.push(d); }
      byDate[d].push(e);
    });
    el('s-list').innerHTML = order.map(d => `
      <div class="day">
        <div class="day-head">${esc(d)}</div>
        ${byDate[d].map(e => `
          <div class="sched-row" data-id="${e.id}">
            <div class="sched-col">${e.subject ? `<div style="font-weight:700;margin-bottom:4px">${esc(e.subject)}</div>` : ''}<b>Models</b>${esc(e.models) || '—'}${e.priority ? `<div class="sched-prio" style="margin-top:6px"><b>⚑ Priority</b>${esc(e.priority)}</div>` : ''}</div>
            <div class="sched-col sched-job"><b>Jobs</b>${esc(e.job) || '—'}</div>
            <div class="sched-col sched-short"><b>★ Shortlist</b>${esc(e.shortlist) || '—'}</div>
            <div class="sched-col sched-fit"><b>Fitting</b>${esc(e.fitting) || '—'}</div>
            <div class="sched-col sched-cast"><b>Casting</b>${esc(e.casting) || '—'}</div>
            <div class="sched-col sched-opt"><b>Options</b>${esc(e.option) || '—'}${e.note ? `<div class="sched-note" style="margin-top:6px"><b>Note</b>${esc(e.note)}</div>` : ''}${e.internalNote ? `<div class="sched-inote" style="margin-top:6px"><b>📝 Internal note</b>${esc(e.internalNote)}</div>` : ''}</div>
            <div style="display:flex;flex-direction:column;gap:6px;align-items:start">
              ${inlineStatusSelect(e)}
              ${inlineBookerSelect(e)}
              <div style="display:flex;gap:10px;flex-wrap:wrap">
                <button class="link notify-entry" data-id="${e.id}" style="color:#06c755">✉ Notify</button>
                ${e.jobCreated ? '<span style="color:var(--teal);font-size:11px">✓ job</span>'
                  : `<button class="link make-job" data-id="${e.id}" style="color:var(--teal)">→ Job</button>`}
                <button class="link sched-edit" data-id="${e.id}">Edit</button>
                <button class="link sched-del" data-id="${e.id}" style="color:var(--declined)">✕</button>
              </div>
            </div>
          </div>`).join('')}
      </div>`).join('');
    wireInlineBookers(el('s-list'));
    el('s-list').querySelectorAll('.make-job').forEach(b =>
      b.addEventListener('click', () => {
        const e = schedule.find(x => x.id === b.dataset.id);
        if (e) openJob(null, jobPrefillFromEntry(e));
      }));
    el('s-list').querySelectorAll('.notify-entry').forEach(btn =>
      btn.addEventListener('click', () => notifyModel(btn.dataset.id)));
    el('s-list').querySelectorAll('.sched-edit').forEach(btn =>
      btn.addEventListener('click', () => editScheduleEntry(btn.dataset.id)));
    el('s-list').querySelectorAll('.sched-del').forEach(btn =>
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this schedule entry?')) return;
        await api('/api/schedule/' + btn.dataset.id, { method: 'DELETE' });
        schedule = schedule.filter(x => x.id !== btn.dataset.id);
        renderSchedule();
      }));
  }

  // --- Type tags + one Details box ---------------------------------
  // The buttons just TAG the entry's type(s); all the content goes in the single
  // Details box. On save, the details are filed into each tagged type's column
  // (so the calendar chips + per-type counts still work). No type tagged → the
  // text is kept as a plain Note.
  const SCHED_CATS = [['job', 'Job'], ['shortlist', 'Shortlist'], ['fitting', 'Fitting'], ['casting', 'Casting'], ['option', 'Option'], ['priority', 'Priority (admin task)']];
  // One type per entry, resolved by the shared schedCat (honours the board stage too),
  // so the drawer opens on the SAME type Month/Board show — and re-saving clears stale tags.
  const CAT2KEY = { job: 'job', short: 'shortlist', fit: 'fitting', cast: 'casting', gosee: 'casting', opt: 'option', prio: 'priority' };
  function typeDetailsSection(entry) {
    const primary = entry ? (CAT2KEY[schedCat(entry)] || null) : null;
    const active = primary ? [primary] : [];
    const details = entry ? ((primary && entry[primary]) || entry.note || entry.priority || '') : '';
    return `
      <div class="field"><label>Type — click to tag</label>
        <div class="cat-btns">
          ${SCHED_CATS.map(([k, label]) =>
            `<button type="button" class="cat-btn${active.includes(k) ? ' active' : ''}" data-cat="${k}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="field"><label>Details</label>
        <textarea id="d-details" rows="4" placeholder="Time, location, photographer, contact, budget, any details…">${esc(details)}</textarea>
      </div>
      <div class="field int-note"><label>📝 Internal note <span style="font-weight:400;color:var(--grey);font-size:11px">· team only — not sent to the model</span></label>
        <textarea id="d-sinternalNote" rows="2" placeholder="Private reminders for the team…">${entry ? esc(entry.internalNote || '') : ''}</textarea>
      </div>`;
  }
  function wireTypeButtons() {
    // Single-select: an entry is ONE type. Picking a type replaces any previous one
    // (so changing e.g. Priority → Job clears Priority — no conflicting tags across views).
    document.querySelectorAll('.cat-btn').forEach(b =>
      b.addEventListener('click', () => {
        const wasActive = b.classList.contains('active');
        document.querySelectorAll('.cat-btn').forEach(x => x.classList.remove('active'));
        if (!wasActive) b.classList.add('active');   // click the active one again → clear (plain note)
        // Priority = admin task → assign it to Admin automatically.
        if (b.dataset.cat === 'priority' && b.classList.contains('active')) {
          const sel = el('d-sbooker'); if (sel) sel.value = 'Admin';
        }
      }));
  }
  // Returns the category fields (+ note) to save, based on the tags + Details box.
  function collectTypeDetails() {
    const details = el('d-details') ? el('d-details').value : '';
    const active = [...document.querySelectorAll('.cat-btn.active')].map(b => b.dataset.cat);
    const out = {}; SCHED_CATS.forEach(([k]) => out[k] = '');
    if (active.length) {
      // The tag lives in the type field's TEXT — an empty Details box must not
      // erase the tag (Lisa's Karine entry lost its type and jumped category).
      const fill = details || (typeof schedSubject === 'function' ? schedSubject() : '') || ' ';
      active.forEach(k => out[k] = fill); out.note = '';
    }
    else { out.note = details; }
    out._activeType = active[0] || '';   // which button is on, even with empty text
    out.internalNote = el('d-sinternalNote') ? el('d-sinternalNote').value : '';
    return out;
  }

  // Booker picker for schedule entries (so castings/options count per booker).
  // Defaults to the logged-in booker's own name.
  function bookerScheduleField(selected, entry) {
    const bookers = bookerRoster();
    const mine = sessionStorage.getItem('mp_admin_bookername') || '';
    const def = selected != null ? selected : mine;   // auto-tag anyone with a booker name (bookers + Admin)
    const cur = (entry && entry.status) || 'open';
    // A booker's entries are always theirs — fill their name automatically and show
    // it read-only (no dropdown to fiddle with). Managers still get the full picker.
    const displayName = def || mine;
    const bookerField = (role === 'booker')
      ? `<div class="field" style="margin:0"><label>Booker</label>
          <input id="d-sbooker" type="hidden" value="${esc(displayName)}">
          <input value="${esc(displayName)}${displayName === mine ? ' (you)' : ''}" readonly style="background:#f5f5f5;color:var(--grey)">
        </div>`
      : `<div class="field" style="margin:0"><label>Booker</label>
          <select id="d-sbooker">
            <option value="">— booker —</option>
            ${bookers.map(b => `<option value="${esc(b)}" ${b === def ? 'selected' : ''}>${esc(b)}</option>`).join('')}
          </select>
        </div>`;
    return `<div class="field two">
      <div class="field" style="margin:0"><label>Status</label>
        <select id="d-sstatus">
          ${LEAD_STATUSES.map(([k, l]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      ${bookerField}
    </div>`;
  }
  const schedBooker = () => (el('d-sbooker') ? el('d-sbooker').value : '');
  const schedStatus = () => (el('d-sstatus') ? el('d-sstatus').value : 'open');

  // Short subject / job name — the entry's headline (shown on the calendar chip).
  function subjectScheduleField(entry) {
    return `<div class="field"><label>Subject / Job name</label>
      <input id="d-ssubject" value="${entry ? esc(entry.subject || '') : ''}" placeholder="e.g. VIVO casting, Gucci shoot, Pomelo lookbook"></div>`;
  }
  const schedSubject = () => (el('d-ssubject') ? el('d-ssubject').value : '');

  // Client block on the schedule entry — New/Returning toggle + Lead source (required)
  // + a contact box. Grouped at the top so bookers capture the client as they type.
  function clientBlockField(entry) {
    const e = entry || {};
    const ct = e.clientType || 'new';
    return `<div class="client-block">
      <div class="cb-head">CLIENT</div>
      <div class="cb-seg">
        <button type="button" class="cbt ${ct === 'new' ? 'active' : ''}" data-ct="new">🆕 New client</button>
        <button type="button" class="cbt ${ct === 'old' ? 'active' : ''}" data-ct="old">🔁 Returning client</button>
      </div>
      <label class="cb-lbl">Lead source <span style="color:var(--declined)">· required — where did this client come from?</span></label>
      <select id="d-sleadSource"><option value="">— pick a source —</option>${LEAD_SOURCES.map(s => `<option value="${esc(s)}" ${(e.leadSource || '') === s ? 'selected' : ''}>${SOURCE_ICON[s] || ''} ${esc(s)}</option>`).join('')}</select>
      <label class="cb-lbl">Client type <span style="color:var(--grey)">· fashion, commercial, film & TV, organizer…</span></label>
      <select id="d-sclientCategory"><option value="">— pick a type —</option>${CLIENT_CATEGORIES.map(c => `<option value="${esc(c)}" ${(e.clientCategory || '') === c ? 'selected' : ''}>${CAT_ICON[c] || ''} ${esc(c)}</option>`).join('')}</select>
      <label class="cb-lbl">Client contact <span style="color:var(--grey)">· name · phone · LINE · email</span></label>
      <input id="d-sclientContact" value="${esc(e.clientContact || '')}" placeholder="e.g. K. Nan · 08x-xxx-xxxx · LINE @nan · nan@brand.com">
    </div>`;
  }
  // Wire the New/Returning toggle inside whatever drawer just rendered a client block.
  function wireClientBlock() {
    el('drawer-body').querySelectorAll('.cbt').forEach(b =>
      b.addEventListener('click', () => {
        el('drawer-body').querySelectorAll('.cbt').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      }));
  }
  const schedClientType = () => { const a = el('drawer-body').querySelector('.cbt.active'); return a ? a.dataset.ct : 'new'; };
  const schedClientContact = () => (el('d-sclientContact') ? el('d-sclientContact').value : '');
  const schedClientCategory = () => (el('d-sclientCategory') ? el('d-sclientCategory').value : '');

  // Multi-day hold: an optional end date. When set, the entry is auto-filled on
  // every day from the start date through this end date (e.g. a 5-day client hold).
  function holdField() {
    return `<div class="field"><label>Hold until (optional — last day of a multi-day hold)</label>
      <input id="d-holduntil" type="date"></div>`;
  }
  const holdUntil = () => (el('d-holduntil') ? el('d-holduntil').value : '');
  // Add days to a YYYY-MM-DD string using UTC (so it's timezone-safe).
  function addDays(ymd, n) {
    const d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function daysBetween(start, end) {
    const out = [];
    let cur = start;
    while (cur && cur <= end) {
      out.push(cur);
      cur = addDays(cur, 1);
      if (out.length > 60) break;   // safety
    }
    return out.length ? out : [start];
  }
  // --- Availability / double-booking guard --------------------------
  const normName = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  function modelTokens(str) {                 // "Alina K, Rosey" -> [{raw,norm}, ...]
    const seen = new Set(), out = [];
    String(str || '').split(/[,\n/]+/).forEach(s => {
      const raw = s.trim(), n = normName(raw);
      if (raw && !seen.has(n)) { seen.add(n); out.push({ raw, norm: n }); }
    });
    return out;
  }
  // For the given model(s) + date(s), find other schedule entries / jobs that
  // already use the same model that day. excludeId skips the entry being edited.
  function computeConflicts(modelsStr, dates, excludeId) {
    const targets = modelTokens(modelsStr);
    const out = [];
    if (!targets.length) return out;
    for (const date of dates) {
      if (!date) continue;
      for (const tg of targets) {
        const hits = [];
        schedule.forEach(e => {
          if (e.id === excludeId || e.date !== date) return;
          if (!modelTokens(e.models).some(m => m.norm === tg.norm)) return;
          const type = catLabel(e);
          // HARD = model is really committed that day (confirmed / shortlist / priority / job).
          // SOFT = a pending option or casting — normal to have several the same day.
          const hard = !!(e.priority || e.shortlist || e.status === 'confirmed' || e.job);
          hits.push({ label: type + (e.subject ? ' ' + e.subject : '') + (e.booker ? ' (' + e.booker + ')' : ''), hard });
        });
        jobs.forEach(j => {
          if (!isISODate(j.jobDate) || j.jobDate !== date) return;
          if (![normName(j.model), normName(j.freelance)].includes(tg.norm)) return;
          hits.push({ label: 'JOB ' + (j.jobTitle || '') + (j.booker ? ' (' + j.booker + ')' : ''), hard: true });
        });
        if (hits.length) out.push({ date, model: tg.raw, hits });
      }
    }
    return out;
  }
  function renderConflicts(dates, excludeId) {
    const box = el('d-conflict');
    if (!box) return;
    const c = computeConflicts(el('d-models') ? el('d-models').value : '', dates, excludeId);
    if (!c.length) { box.style.display = 'none'; box.innerHTML = ''; box.className = 'conflict-box'; return; }
    const anyHard = c.some(x => x.hits.some(h => h.hard));
    box.style.display = 'block';
    box.className = 'conflict-box' + (anyHard ? ' hard' : ' soft');
    const header = anyHard
      ? '<b>⚠ Clash — this model is already committed that day:</b>'
      : '<b>ℹ This model also has options that day (not confirmed — normal):</b>';
    box.innerHTML = header + c.slice(0, 8).map(x => {
      const hard = x.hits.filter(h => h.hard).map(h => esc(h.label));
      const soft = x.hits.filter(h => !h.hard).map(h => esc(h.label));
      const parts = [];
      if (hard.length) parts.push(`<span class="c-hard">🔴 ${hard.join(' | ')}</span>`);
      if (soft.length) parts.push(`<span class="c-soft">ℹ ${soft.join(' | ')}</span>`);
      return `<div>• <b>${esc(x.model)}</b> · ${esc(x.date)}: ${parts.join(' · ')}</div>`;
    }).join('') + (c.length > 8 ? `<div>…and ${c.length - 8} more</div>` : '');
  }
  function setupConflictCheck(getDates, excludeId) {
    const update = () => renderConflicts(getDates(), excludeId);
    ['d-models', 'd-date', 'd-holduntil'].forEach(id => { const e = el(id); if (e) e.addEventListener('input', update); });
    onPickerChange = update;   // re-check conflicts whenever the day picker changes
    update();
  }
  // Save-time guard: returns true to proceed, false to abort.
  function passesConflictGuard(getDates, excludeId) {
    const c = computeConflicts(el('d-models') ? el('d-models').value : '', getDates(), excludeId);
    // Only a HARD conflict (confirmed / shortlist / priority / job) needs a prompt —
    // parallel pending options are normal and never block.
    const hard = c.filter(x => x.hits.some(h => h.hard));
    if (!hard.length) return true;
    return confirm('⚠ This model is already committed that day:\n\n'
      + hard.slice(0, 10).map(x => '• ' + x.model + ' · ' + x.date + ': '
        + x.hits.filter(h => h.hard).map(h => h.label).join(' | ')).join('\n')
      + '\n\nBook anyway?');
  }

  // Warn if a booker is about to re-add something that already exists on the same
  // day (same models + same subject/casting/job) — catches accidental duplicates.
  // Returns the matching existing entry, or null.
  function findDuplicateEntry(base, dates) {
    const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const models = norm(base.models);
    const subj = norm(base.subject);
    const content = norm(base.casting || base.fitting || base.job || base.option);
    if (!models && !subj && !content) return null;
    const dset = new Set(dates);
    for (const e of schedule) {
      if (!dset.has(e.date)) continue;
      const sameModels = models && norm(e.models) === models;
      const sameSubj = subj && norm(e.subject) === subj;
      const eContent = norm(e.casting || e.fitting || e.job || e.option);
      const sameContent = content && eContent === content;
      // A likely duplicate = same models + same subject/content, OR same subject + same content.
      if ((sameModels && (sameSubj || sameContent)) || (sameSubj && sameContent)) return e;
    }
    return null;
  }
  // Returns true to proceed. Prompts if it looks like a duplicate of an existing entry.
  function passesDuplicateGuard(base, dates) {
    const dup = findDuplicateEntry(base, dates);
    if (!dup) return true;
    const what = dup.subject || firstLine(dup.casting || dup.fitting || dup.job || dup.option || '');
    return confirm(`⚠ This looks like it's already added on ${dup.date}:\n\n`
      + `${dup.models || ''}${what ? '  —  ' + what : ''}\n\n`
      + `Add it again anyway?`);
  }

  // Create one entry per day of a hold (or a single entry if no end date).
  async function createScheduleEntries(baseData, startDate, endDate) {
    const dates = (endDate && endDate > startDate) ? daysBetween(startDate, endDate) : [startDate];
    const holdGroup = dates.length > 1 ? (crypto.randomUUID ? crypto.randomUUID() : 'h' + Date.now()) : '';
    const created = [];
    for (const dt of dates) {
      const data = { ...baseData, date: dt };
      if (holdGroup) { data.holdGroup = holdGroup; data.holdStart = startDate; data.holdEnd = endDate; }
      const r = await api('/api/schedule', { method: 'POST', body: JSON.stringify(data) });
      if (r.entry) created.push(r.entry);
    }
    return created;
  }

  // ---- Multi-day OPTION picker: click ANY days (contiguous or not) to hold ----
  // Clients often hold scattered days (fitting 3–4, shoot 6–11). Bookers click each
  // held day; all become ONE linked option (holdGroup) so a report counts it as 1.
  let pickedDates = new Set();
  let pickerMonth = null;
  let onPickerChange = null;
  const fmtNice = ds => { const p = ds.split('-').map(Number); return `${p[2]} ${MONTH_NAMES[p[1] - 1]}`; };
  const pickedList = () => [...pickedDates].sort();

  function multiDateField(label) {
    return `<div class="field">
      <label>${label}</label>
      <div class="mini-cal" id="d-picker"></div>
      <div id="d-picked" class="picked-summary"></div>
    </div>`;
  }
  function renderDatePicker() {
    const host = el('d-picker'); if (!host) return;
    if (!pickerMonth) pickerMonth = (pickedList()[0] || todayLocal()).slice(0, 7);
    const [y, m] = pickerMonth.split('-').map(Number);
    const startDow = new Date(y, m - 1, 1).getDay();
    const dim = new Date(y, m, 0).getDate();
    const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    let cells = '';
    for (let i = 0; i < startDow; i++) cells += '<span class="mc-cell empty"></span>';
    for (let d = 1; d <= dim; d++) {
      const ds = `${pickerMonth}-${String(d).padStart(2, '0')}`;
      cells += `<span class="mc-cell${pickedDates.has(ds) ? ' picked' : ''}" data-d="${ds}">${d}</span>`;
    }
    host.innerHTML = `
      <div class="mc-head">
        <button type="button" class="mc-nav" id="mc-prev">‹</button>
        <span>${monthLabel(pickerMonth)}</span>
        <button type="button" class="mc-nav" id="mc-next">›</button>
      </div>
      <div class="mc-grid">${DOW.map(d => `<span class="mc-dow">${d}</span>`).join('')}${cells}</div>`;
    el('mc-prev').addEventListener('click', () => { pickerMonth = shiftMonth(pickerMonth, -1); renderDatePicker(); });
    el('mc-next').addEventListener('click', () => { pickerMonth = shiftMonth(pickerMonth, 1); renderDatePicker(); });
    host.querySelectorAll('.mc-cell[data-d]').forEach(c =>
      c.addEventListener('click', () => {
        const ds = c.dataset.d;
        if (pickedDates.has(ds)) pickedDates.delete(ds); else pickedDates.add(ds);
        renderDatePicker();
        if (onPickerChange) onPickerChange();
      }));
    const picked = pickedList();
    el('d-picked').innerHTML = picked.length
      ? `<b>${picked.length} day${picked.length > 1 ? 's' : ''} held:</b> ${picked.map(fmtNice).join(', ')}`
      : `<span style="color:var(--grey)">Click the days the model is held (tap again to remove).</span>`;
  }
  // ---- Stage day-painter (Tawa's request) --------------------------
  // One calendar where you pick a stage, then click the day(s) for it — so a single
  // booking can have its casting, fitting and shooting on DIFFERENT days at once.
  // [brush key, schedule field it fills, label, forced board stage (optional)]
  const STAGE_BRUSHES = [
    ['shooting', 'job', 'Shooting (Job)'],
    ['shortlist', 'shortlist', 'Shortlist'],
    ['fitting', 'fitting', 'Fitting'],
    ['casting', 'casting', 'Casting'],
    ['goandsee', 'casting', 'Go & See', 'goandsee'],
    ['option', 'option', 'Option (hold)'],
    ['priority', 'priority', 'Priority'],
  ];
  let stageDays = null;          // { casting:Set, fitting:Set, ... }
  let activeBrush = 'casting';
  let stagePickerMonth = null;
  const allStageDates = () => {
    const s = new Set();
    if (stageDays) Object.values(stageDays).forEach(set => set.forEach(d => s.add(d)));
    return [...s].sort();
  };
  function stagePickerField() {
    return `<div class="field">
      <label>Plan the days — pick a stage, then click its day(s). Casting, fitting &amp; shooting can be different days.</label>
      <div class="cat-btns" id="brush-btns"></div>
      <div class="mini-cal" id="stage-cal"></div>
      <div id="stage-summary" class="picked-summary"></div>
    </div>`;
  }
  function renderStagePicker() {
    const bhost = el('brush-btns'); if (!bhost) return;
    bhost.innerHTML = STAGE_BRUSHES.map(([brush, , label]) => {
      const n = stageDays[brush].size;
      return `<button type="button" class="cat-btn${activeBrush === brush ? ' active' : ''}" data-brush="${brush}" data-cat="${brush}">${label}${n ? ` · ${n}` : ''}</button>`;
    }).join('');
    bhost.querySelectorAll('.cat-btn').forEach(b =>
      b.addEventListener('click', () => { activeBrush = b.dataset.brush; renderStagePicker(); }));
    // If days sit on ONE other brush and the active brush has none, offer a
    // one-click transfer. (Aim painted 7 days on the default Shooting brush,
    // then clicked Priority — the days silently stayed as a Job.)
    document.querySelectorAll('.brush-move-hint').forEach(h => h.remove());   // no stacking on re-render
    const otherWithDays = STAGE_BRUSHES.filter(([k]) => k !== activeBrush && stageDays[k].size);
    if (stageDays[activeBrush].size === 0 && otherWithDays.length === 1) {
      const [fromKey, , fromLabel] = otherWithDays[0];
      const toLabel = (STAGE_BRUSHES.find(([k]) => k === activeBrush) || [])[2] || activeBrush;
      el('stage-summary').insertAdjacentHTML('beforebegin',
        `<div class="brush-move-hint">${stageDays[fromKey].size} day(s) are on <b>${fromLabel}</b> — ` +
        `<button type="button" class="link" id="brush-move">Move them to ${toLabel}</button></div>`);
      const mv = el('brush-move');
      if (mv) mv.addEventListener('click', () => {
        stageDays[fromKey].forEach(ds => stageDays[activeBrush].add(ds));
        stageDays[fromKey].clear();
        renderStagePicker();
        if (onPickerChange) onPickerChange();
      });
    }

    const host = el('stage-cal'); if (!host) return;
    if (!stagePickerMonth) stagePickerMonth = (allStageDates()[0] || todayLocal()).slice(0, 7);
    const [y, m] = stagePickerMonth.split('-').map(Number);
    const startDow = new Date(y, m - 1, 1).getDay();
    const dim = new Date(y, m, 0).getDate();
    const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const stageOf = ds => { for (const [brush] of STAGE_BRUSHES) if (stageDays[brush].has(ds)) return brush; return ''; };
    let cells = '';
    for (let i = 0; i < startDow; i++) cells += '<span class="mc-cell empty"></span>';
    for (let d = 1; d <= dim; d++) {
      const ds = `${stagePickerMonth}-${String(d).padStart(2, '0')}`;
      const st = stageOf(ds);
      cells += `<span class="mc-cell${st ? ' st-' + st : ''}" data-d="${ds}">${d}</span>`;
    }
    host.innerHTML = `
      <div class="mc-head">
        <button type="button" class="mc-nav" id="sc-prev">‹</button>
        <span>${monthLabel(stagePickerMonth)}</span>
        <button type="button" class="mc-nav" id="sc-next">›</button>
      </div>
      <div class="mc-grid">${DOW.map(d => `<span class="mc-dow">${d}</span>`).join('')}${cells}</div>`;
    el('sc-prev').addEventListener('click', () => { stagePickerMonth = shiftMonth(stagePickerMonth, -1); renderStagePicker(); });
    el('sc-next').addEventListener('click', () => { stagePickerMonth = shiftMonth(stagePickerMonth, 1); renderStagePicker(); });
    host.querySelectorAll('.mc-cell[data-d]').forEach(c =>
      c.addEventListener('click', () => {
        const ds = c.dataset.d;
        const inActive = stageDays[activeBrush].has(ds);
        STAGE_BRUSHES.forEach(([brush]) => stageDays[brush].delete(ds));   // a day belongs to one stage
        if (!inActive) stageDays[activeBrush].add(ds);
        renderStagePicker();
        if (onPickerChange) onPickerChange();
      }));
    const parts = STAGE_BRUSHES.filter(([b]) => stageDays[b].size)
      .map(([b, , label]) => `<b>${label}:</b> ${[...stageDays[b]].sort().map(fmtNice).join(', ')}`);
    el('stage-summary').innerHTML = parts.length
      ? parts.join(' &nbsp;·&nbsp; ')
      : `<span style="color:var(--grey)">Pick a stage above, then click the day(s) for it.</span>`;
  }
  // Create the entries: casting/fitting/shooting/shortlist/priority = one per day;
  // an Option on several days links as one multi-day hold (like before).
  async function createStagedEntries(base, details) {
    const created = [];
    // One booking may span several stages on different days — link them so you can
    // see casting + fitting + shooting of the same booking together (planGroup).
    const usedBrushes = STAGE_BRUSHES.filter(([b]) => stageDays[b].size).length;
    const plan = usedBrushes > 1 ? (crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now()) : '';
    for (const [brush, field, , forcedStage] of STAGE_BRUSHES) {
      const days = [...stageDays[brush]].sort();
      if (!days.length) continue;
      const hold = brush === 'option' && days.length > 1;
      const hg = hold ? (crypto.randomUUID ? crypto.randomUUID() : 'h' + Date.now()) : '';
      for (const dt of days) {
        const data = { ...base, date: dt, [field]: details || base.subject || '' };
        if (forcedStage) data.stage = forcedStage;   // e.g. Go & See → its own board column
        else if (brush === 'shooting') data.stage = 'shooting';   // pin shooting to its board column
        if (plan) data.planGroup = plan;
        if (hold) { data.holdGroup = hg; data.holdStart = days[0]; data.holdEnd = days[days.length - 1]; }
        const r = await api('/api/schedule', { method: 'POST', body: JSON.stringify(data) });
        if (r.entry) created.push(r.entry);
      }
    }
    return created;
  }

  // Create one entry per PICKED day; link them as one hold (option) when there's >1.
  async function createScheduleForDates(baseData, dates) {
    const uniq = [...new Set(dates)].filter(Boolean).sort();
    const holdGroup = uniq.length > 1 ? (crypto.randomUUID ? crypto.randomUUID() : 'h' + Date.now()) : '';
    const created = [];
    for (const dt of uniq) {
      const data = { ...baseData, date: dt };
      if (holdGroup) { data.holdGroup = holdGroup; data.holdStart = uniq[0]; data.holdEnd = uniq[uniq.length - 1]; }
      const r = await api('/api/schedule', { method: 'POST', body: JSON.stringify(data) });
      if (r.entry) created.push(r.entry);
    }
    return created;
  }

  // Time is a TYPE-or-PICK combo: bookers can type "2pm", "14:00", "2:30 PM", or
  // pick a 15-minute suggestion from the dropdown. Stored as whatever they type.
  function timeDatalist() {
    let out = '<datalist id="time-slots">';
    for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 15) {
      const ampm = h < 12 ? 'AM' : 'PM', h12 = h % 12 === 0 ? 12 : h % 12;
      out += `<option value="${h12}:${String(m).padStart(2, '0')} ${ampm}"></option>`;
    }
    return out + '</datalist>';
  }
  function timeScheduleField(entry) {
    const s = entry ? esc(entry.timeStart || '') : '', e = entry ? esc(entry.timeEnd || '') : '';
    return `<div class="field two">
      <div class="field" style="margin:0"><label>Time (start)</label><input id="d-stimestart" list="time-slots" autocomplete="off" placeholder="e.g. 2:00 PM" value="${s}"></div>
      <div class="field" style="margin:0"><label>Time (end)</label><input id="d-stimeend" list="time-slots" autocomplete="off" placeholder="e.g. 4:00 PM" value="${e}"></div>
    </div>${timeDatalist()}`;
  }
  // Parse a free-typed time to minutes-since-midnight, for sorting (handles
  // "2:30 PM", "2pm", "14:30", "9.30"). Returns big number if unparseable.
  function parseTimeMin(str) {
    const t = String(str || '').trim().toLowerCase();
    if (!t) return 99999;
    const m = t.match(/^(\d{1,2})[:.\s]?(\d{2})?\s*(am|pm)?/);
    if (!m) return 99999;
    let h = +m[1]; const min = m[2] ? +m[2] : 0; const ap = m[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return h * 60 + min;
  }
  const schedTimeStart = () => (el('d-stimestart') ? el('d-stimestart').value : '');
  const schedTimeEnd = () => (el('d-stimeend') ? el('d-stimeend').value : '');
  // How many days the actual shoot runs (fees are often per shoot day). Optional.
  function shootDaysField(entry) {
    const v = entry && entry.shootDays ? entry.shootDays : '';
    return `<div class="field"><label>Shoot days (optional — carried to the job; fee is often per day)</label>
      <input id="d-shootdays" type="number" min="1" max="10" step="1" placeholder="e.g. 1 or 2" value="${v}" style="max-width:160px"></div>`;
  }
  const schedShootDays = () => (el('d-shootdays') ? el('d-shootdays').value : '');

  // Build a pre-filled job draft from a casting/option/job schedule entry.
  function jobPrefillFromEntry(e) {
    const details = [
      e.clientContact && 'Client contact: ' + e.clientContact,
      e.fitting && 'Fitting: ' + e.fitting,
      e.casting && 'Casting: ' + e.casting,
      e.option && 'Option: ' + e.option,
      e.job && 'Job: ' + e.job,
      e.note && 'Note: ' + e.note,
    ].filter(Boolean).join('\n\n');
    return {
      _fromScheduleId: e.id,
      model: e.models,
      booker: e.booker,
      jobDate: isISODate(e.date) ? e.date : '',
      jobTitle: e.subject || firstLine(e.job || e.fitting || e.casting || e.option || e.note || ''),
      notes: details,
      shootDays: e.shootDays || '',
      leadSource: e.leadSource || '',        // carry the lead source from the casting → the job
      clientCategory: e.clientCategory || '', // carry the client type through too
      status: 'confirmed',
    };
  }

  // --- Notify a model (LINE / WhatsApp / Email / Copy) --------------
  // Builds a ready-to-send message from a schedule entry. The booker sends it
  // from their own app — nothing goes out automatically (no infra needed).
  // Never let our own system links (the admin app / any Railway host) end up in a
  // message that goes to a model or client — a recipient could poke at the login page.
  function stripInternalLinks(text) {
    return String(text || '')
      .replace(/https?:\/\/(?:www\.)?(?:booking|finance)\.mpmodelsbkk\.com\S*/gi, '')
      .replace(/https?:\/\/\S*\.up\.railway\.app\S*/gi, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function buildNotifyMessage(e) {
    const typeLabel = { prio: 'Admin task', short: 'Shortlist (hold)', job: 'Job', fit: 'Fitting', opt: 'Option', cast: 'Casting', gosee: 'Go & See' }[schedCat(e)] || 'Schedule';
    const time = e.timeStart ? (e.timeStart + (e.timeEnd ? '–' + e.timeEnd : '')) : '';
    const body = entryText(e);
    const msg = [
      'MP Models',
      e.subject || typeLabel,
      e.models ? 'Model: ' + e.models : '',
      'Date: ' + (e.date || 'TBC') + (time ? '   Time: ' + time : ''),
      'Type: ' + typeLabel,
      body ? '\nDetails:\n' + body : '',
      (e.note && e.note !== body) ? '\nNote: ' + e.note : '',
      '\nBooker: ' + (e.booker || 'MP Models'),
    ].filter(Boolean).join('\n');
    return stripInternalLinks(msg);   // internal note is never included here anyway
  }
  function notifyModel(id) {
    const e = schedule.find(x => x.id === id);
    if (!e) return;
    // Pull each model named on this entry from the directory, so their contact is ready.
    const named = String(e.models || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    const found = named.map(modelByName).filter(Boolean);
    const one = found.length === 1 ? found[0] : null;   // auto-target when it's a single model
    const waDigits = m => ((m && m.whatsapp) || '').replace(/[^\d]/g, '');
    const contactsHtml = found.length ? `<div class="field"><label>Contacts on file</label>
      <div style="font-size:13px;line-height:1.7">${found.map(m => `<div><b>${esc(m.name)}</b> — ${
        [m.phone && ('📱 ' + esc(m.phone)), m.line && ('🟢 ' + esc(m.line)), m.whatsapp && ('💬 ' + esc(m.whatsapp)), m.email && ('✉ ' + esc(m.email))].filter(Boolean).join(' · ')
        || '<span style="color:var(--declined)">no contact saved — add it in Models</span>'}</div>`).join('')}</div></div>` : '';
    el('d-title').textContent = 'Notify model';
    el('drawer-body').innerHTML = `
      <p style="color:var(--grey);font-size:12.5px;margin:0 0 12px">The message opens in your app pre-filled${one ? ' — WhatsApp &amp; Email go straight to <b>' + esc(one.name) + '</b>' : ''}.</p>
      ${contactsHtml}
      <div class="field"><label>Message (edit if needed)</label>
        <textarea id="d-notify-msg" rows="8">${esc(buildNotifyMessage(e))}</textarea></div>
      <div class="drawer-actions" style="flex-wrap:wrap">
        <button class="btn" id="n-line" style="background:#06c755;border-color:#06c755">Send via LINE</button>
        <button class="btn" id="n-wa" style="background:#25d366;border-color:#25d366">WhatsApp${one && waDigits(one) ? ' → ' + esc(one.name) : ''}</button>
        <button class="btn ghost" id="n-email">Email${one && one.email ? ' → ' + esc(one.name) : ''}</button>
        <button class="link" id="n-copy">Copy text</button>
        <span id="n-copied" style="display:none;color:var(--teal);font-size:12px">Copied ✓</span>
      </div>`;
    const msg = () => stripInternalLinks(el('d-notify-msg').value);   // clean even if pasted in by hand
    el('n-line').addEventListener('click', () => window.open('https://line.me/R/msg/text/?' + encodeURIComponent(msg()), '_blank'));
    el('n-wa').addEventListener('click', () => {
      const d = waDigits(one);
      window.open('https://wa.me/' + d + (d ? '?' : '?') + 'text=' + encodeURIComponent(msg()), '_blank');
    });
    el('n-email').addEventListener('click', () => {
      const to = (one && one.email) ? one.email : '';
      window.location.href = 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent('MP Models — ' + (e.subject || 'Schedule')) + '&body=' + encodeURIComponent(msg());
    });
    el('n-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(msg()); el('n-copied').style.display = 'inline'; } catch (_) {} });
    openDrawer();
  }

  // --- Click a calendar day → see + add that day's entries ----------
  // openDay(dateStr)          → the whole day: add-form on top + every entry below
  // openDay(dateStr, focusId) → ONLY that one booking's card (used from the Board)
  function openDay(dateStr, focusId) {
    const focused = !!focusId;
    const all = schedule.filter(e => e.date === dateStr);
    const entries = focused ? all.filter(e => e.id === focusId) : all;
    el('d-title').textContent = focused
      ? (entries[0] ? (entries[0].subject || entries[0].models || 'Booking') : 'Booking')
      : dateStr;
    const listHtml = entries.map(e => `
      <div class="day-entry" data-id="${e.id}">
        ${e.subject ? `<div style="font-weight:700;font-size:15px;margin-bottom:3px">${esc(e.subject)}</div>` : ''}
        ${e.holdEnd ? `<div style="font-size:11px;color:var(--web);font-weight:700;margin-bottom:3px">🔒 Hold: ${esc(e.holdStart)} → ${esc(e.holdEnd)}</div>` : ''}
        <div class="models">${esc(e.models) || '—'}</div>
        <div class="sched-booker-wrap">Status ${inlineStatusSelect(e)} &nbsp; Booker ${inlineBookerSelect(e)}</div>
        ${e.priority ? `<div class="line sched-prio"><b>⚑ Priority — admin task</b>${esc(e.priority)}
          <div class="prio-warn">This model has an admin task (e.g. visa run / work permit) — they're occupied this day, don't book them.</div></div>` : ''}
        ${e.job ? `<div class="line sched-job"><b>Jobs</b>${esc(e.job)}</div>` : ''}
        ${e.shortlist ? `<div class="line sched-short"><b>★ Shortlist</b>${esc(e.shortlist)}
          <div class="short-warn">⚠ Almost confirmed — this model is held for ${esc(e.booker) || 'the booker'} that day. Don't book them elsewhere; check with the booker first.</div></div>` : ''}
        ${e.fitting ? `<div class="line sched-fit"><b>Fitting</b>${esc(e.fitting)}</div>` : ''}
        ${e.casting ? `<div class="line sched-cast"><b>Casting</b>${esc(e.casting)}</div>` : ''}
        ${e.option ? `<div class="line sched-opt"><b>Options</b>${esc(e.option)}</div>` : ''}
        ${e.note ? `<div class="line sched-note"><b>Note / Details</b>${esc(e.note)}</div>` : ''}
        ${e.internalNote ? `<div class="line sched-inote"><b>📝 Internal note — team only</b>${esc(e.internalNote)}</div>` : ''}
        <div style="display:flex;gap:14px;margin-top:4px;align-items:center;flex-wrap:wrap">
          <button class="link notify-entry" data-id="${e.id}" style="color:#06c755;font-weight:600">✉ Notify model</button>
          ${e.jobCreated
            ? '<span style="color:var(--teal);font-size:12px">✓ Job created</span>'
            : `<button class="link make-job" data-id="${e.id}" style="color:var(--teal);font-weight:600">→ Create job</button>`}
          <button class="link day-copy" data-id="${e.id}" style="color:var(--web);font-weight:600">⧉ Copy to day(s)</button>
          <button class="link day-edit" data-id="${e.id}">Edit</button>
          <button class="link day-del" data-id="${e.id}" style="color:var(--declined)">Delete</button>
        </div>
      </div>`).join('') || '<p style="color:var(--grey)">Nothing scheduled yet.</p>';

    // Full-day view opens with an add-form on top; the focused (single-card) view
    // from the Board shows just that one booking — no add-form, no other entries.
    if (focused) {
      el('drawer-body').innerHTML = listHtml;
    } else {
      const addForm = `
        ${subjectScheduleField(null)}
        <div class="field"><label>Add — Models</label><input id="d-models"></div>
        <div id="d-conflict" class="conflict-box" style="display:none"></div>
        ${multiDateField('Held dates — click each day the model is held (any combo, e.g. 3–4 and 6–11)')}
        ${bookerScheduleField(null)}
        ${timeScheduleField(null)}
        ${shootDaysField(null)}
        ${typeDetailsSection(null)}
        ${clientBlockField(null)}
        <div class="drawer-actions"><button class="btn" id="d-add-day">Add entry</button></div>`;
      el('drawer-body').innerHTML = addForm
        + `<hr style="border:none;border-top:1px solid var(--line);margin:18px 0 10px">`
        + `<div style="font-weight:700;font-size:13px;color:var(--grey);margin-bottom:8px">Already on ${esc(dateStr)}</div>`
        + listHtml;
      wireTypeButtons();
      pickedDates = new Set([dateStr]);          // the day they clicked starts selected
      pickerMonth = dateStr.slice(0, 7);
      renderDatePicker();
      wireClientBlock();   // lead source / client type buttons on the quick-add form
      const getAddDates = () => pickedList();
      setupConflictCheck(getAddDates, null);
      el('d-add-day').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn.disabled) return;                 // guard: ignore rapid repeat taps
        const dates = getAddDates();
        if (!dates.length) { alert('Click at least one day to hold.'); return; }
        const base = { models: el('d-models').value, subject: schedSubject(), booker: schedBooker(), status: schedStatus(), timeStart: schedTimeStart(), timeEnd: schedTimeEnd(), shootDays: schedShootDays(), leadSource: el('d-sleadSource') ? el('d-sleadSource').value : '', clientType: schedClientType(), clientContact: schedClientContact(), clientCategory: schedClientCategory(), ...collectTypeDetails() };
        // The chosen type sets the stage on NEW entries too — so a fresh Option
        // can't land with a blank/mismatched stage and drift categories later.
        const addType = base._activeType; delete base._activeType;
        // The chosen type decides the column — a Confirmed status must not turn
        // a Shortlist/Fitting into a Job (only the 'job' type maps to shooting).
        if (addType) base.stage = ({ job: 'shooting', shortlist: 'shortlist', fitting: 'fitting', casting: 'casting', option: 'option', priority: 'priority' })[addType];
        if (!(base.models || base.casting || base.fitting || base.option || base.job || base.shortlist || base.priority || base.note)) { alert('Add something first.'); return; }
        if (!passesDuplicateGuard(base, dates)) return;
        if (!passesConflictGuard(getAddDates, null)) return;
        btn.disabled = true; btn.textContent = 'Adding…';
        try {
          const created = await createScheduleForDates(base, dates);
          created.forEach(e => schedule.push(e));
          buildFilters(); renderSchedule(); openDay(dateStr);
        } catch (_) { btn.disabled = false; btn.textContent = 'Add entry'; }
      });
    }
    const reopen = () => openDay(dateStr, focusId);   // refresh keeps the same (focused or full) view

    el('drawer-body').querySelectorAll('.day-del').forEach(b =>
      b.addEventListener('click', async () => {
        const e = schedule.find(x => x.id === b.dataset.id);
        if (e && e.holdGroup) {
          const group = schedule.filter(x => x.holdGroup === e.holdGroup);
          if (!confirm(`This is part of a ${group.length}-day hold (${e.holdStart} → ${e.holdEnd}). Delete ALL ${group.length} days?`)) return;
          for (const g of group) await api('/api/schedule/' + g.id, { method: 'DELETE' });
          schedule = schedule.filter(x => x.holdGroup !== e.holdGroup);
        } else {
          if (!confirm('Delete this entry?')) return;
          await api('/api/schedule/' + b.dataset.id, { method: 'DELETE' });
          schedule = schedule.filter(x => x.id !== b.dataset.id);
        }
        renderSchedule();
        if (focused) closeDrawer(); else reopen();   // the focused booking is gone → close
      }));
    el('drawer-body').querySelectorAll('.day-edit').forEach(b =>
      b.addEventListener('click', () => editScheduleEntry(b.dataset.id, reopen)));
    el('drawer-body').querySelectorAll('.day-copy').forEach(b =>
      b.addEventListener('click', () => openCopyEntry(b.dataset.id)));
    el('drawer-body').querySelectorAll('.make-job').forEach(b =>
      b.addEventListener('click', () => {
        const e = schedule.find(x => x.id === b.dataset.id);
        if (e) openJob(null, jobPrefillFromEntry(e));
      }));
    el('drawer-body').querySelectorAll('.notify-entry').forEach(b =>
      b.addEventListener('click', () => notifyModel(b.dataset.id)));
    wireInlineBookers(el('drawer-body'));
    openDrawer();
  }

  // --- Copy an entry to other day(s) --------------------------------
  // Same info, new days — for when a model can't make it and the booker sends
  // someone else another day, or the same casting runs across several days.
  function openCopyEntry(id) {
    const e = schedule.find(x => x.id === id);
    if (!e) return;
    const detail = e.subject || firstLine(entryText(e)) || '(no details)';
    const typeLabel = catLabel(e);
    el('d-title').textContent = 'Copy to other day(s)';
    el('drawer-body').innerHTML = `
      <div class="card" style="padding:12px 14px;margin-bottom:14px">
        <div style="font-weight:700">${esc(detail)}</div>
        <div style="font-size:12.5px;color:var(--grey);margin-top:3px">${esc(typeLabel)} · ${esc(e.models) || 'no model'} · from ${esc(e.date)}${e.booker ? ' · ' + esc(e.booker) : ''}</div>
      </div>
      <div class="field"><label>Change the model(s) if needed <span style="font-weight:400;color:var(--grey);font-size:11px">· e.g. send a different model</span></label>
        <input id="d-copy-models" value="${esc(e.models)}"></div>
      ${multiDateField('Pick the day(s) to copy this to — click each day')}
      <div class="drawer-actions"><button class="btn" id="d-copy-go">Copy to selected day(s)</button></div>`;
    pickedDates = new Set();                 // start empty — they choose new days
    pickerMonth = e.date.slice(0, 7);
    renderDatePicker();
    el('d-copy-go').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      if (btn.disabled) return;
      const days = pickedList();
      if (!days.length) { alert('Click at least one day to copy to.'); return; }
      btn.disabled = true; btn.textContent = 'Copying…';
      // Copy every field except the identity/date/hold ones — keep type, details, time, booker.
      // Never copy identity/link fields: stage (a fresh copy starts un-staged),
      // jobRef/planGroup (the copy is NOT part of the original job/plan — a copied
      // jobRef would get the copy deleted by that job's next shoot-date sync),
      // and postponeDate (belongs to the original's status history).
      const SKIP = { id: 1, date: 1, month: 1, holdGroup: 1, holdStart: 1, holdEnd: 1, notified: 1, jobCreated: 1, stage: 1, jobRef: 1, planGroup: 1, postponeDate: 1 };
      const baseCopy = {};
      Object.keys(e).forEach(k => { if (!SKIP[k]) baseCopy[k] = e[k]; });
      baseCopy.models = el('d-copy-models').value;
      baseCopy.status = 'open';              // a fresh copy starts open, not declined
      try {
        const created = [];
        for (const dt of days) {
          const r = await api('/api/schedule', { method: 'POST', body: JSON.stringify({ ...baseCopy, date: dt }) });
          if (r.entry) { schedule.push(r.entry); created.push(r.entry); }
        }
        if (!created.length) { btn.disabled = false; btn.textContent = 'Copy to selected day(s)'; alert('Nothing was copied — please try again.'); return; }
        const firstDay = days.slice().sort()[0];
        dayDate = firstDay; boardAll = false; calMonth = firstDay.slice(0, 7);
        buildFilters(); renderSchedule(); closeDrawer();
        toast(`Copied ✓  to ${created.length} day${created.length === 1 ? '' : 's'}`);
      } catch (_) { btn.disabled = false; btn.textContent = 'Copy to selected day(s)'; }
    });
    openDrawer();
  }

  // --- Edit a single schedule entry ---------------------------------
  // afterSave (optional): a callback to run after saving/deleting, e.g. reopen
  // the day popup. If omitted, the drawer just closes.
  function editScheduleEntry(id, afterSave) {
    const e = schedule.find(x => x.id === id);
    if (!e) return;
    // Wolf: his own scouting entries open his simple diary drawer; everything
    // else stays view-only (the server refuses his writes anyway).
    if (role === 'scouter') {
      if (e.createdBy && e.createdBy === (sessionStorage.getItem('mp_admin_email') || '')) scoutEntryDrawer(e);
      return;
    }
    const done = () => { buildFilters(); renderSchedule(); if (afterSave) afterSave(); else closeDrawer(); };
    el('d-title').textContent = 'Edit schedule entry';
    el('drawer-body').innerHTML = `
      <div class="field"><label>Date</label><input id="d-date" type="date" value="${esc(e.date)}"></div>
      ${subjectScheduleField(e)}
      ${clientBlockField(e)}
      <div class="field"><label>Models</label><input id="d-models" value="${esc(e.models)}"></div>
      <div id="d-conflict" class="conflict-box" style="display:none"></div>
      ${bookerScheduleField(e.booker || '', e)}
      <div class="field" id="d-postpone-wrap" style="display:${e.status === 'postponed' ? 'block' : 'none'}">
        <label>Postpone to — new date <span style="font-weight:400;color:var(--grey);font-size:11px">· optional</span></label>
        <input id="d-postponeDate" type="date" value="${esc(isISODate(e.postponeDate) ? e.postponeDate : '')}" style="max-width:200px">
      </div>
      ${timeScheduleField(e)}
      ${shootDaysField(e)}
      ${typeDetailsSection(e)}
      <div class="drawer-actions">
        <button class="btn" id="d-save">Save changes</button>
        <button class="link" id="d-del" style="color:var(--declined)">Delete</button>
      </div>`;
    wireTypeButtons();
    wireClientBlock();
    // Reveal the "postpone to" date only when Postponed is chosen.
    const statusEl = el('d-sstatus');
    if (statusEl) statusEl.addEventListener('change', () => {
      const w = el('d-postpone-wrap'); if (w) w.style.display = statusEl.value === 'postponed' ? 'block' : 'none';
    });
    const getEditDates = () => [el('d-date').value];
    setupConflictCheck(getEditDates, id);
    el('d-save').addEventListener('click', async () => {
      if (!passesConflictGuard(getEditDates, id)) return;
      const data = { date: el('d-date').value, models: el('d-models').value, subject: schedSubject(), booker: schedBooker(), status: schedStatus(), timeStart: schedTimeStart(), timeEnd: schedTimeEnd(), shootDays: schedShootDays(), leadSource: el('d-sleadSource') ? el('d-sleadSource').value : '', clientType: schedClientType(), clientContact: schedClientContact(), clientCategory: schedClientCategory(), ...collectTypeDetails() };
      data.postponeDate = (data.status === 'postponed' && el('d-postponeDate')) ? el('d-postponeDate').value : '';
      // CATEGORY LOCK (Lisa's rule): saving other info must NEVER move an entry
      // to another category. The stage is rewritten ONLY when the booker
      // explicitly clicked a DIFFERENT type button (that keeps Aim's fix — a
      // changed type still clears a stale stage from an old drag/brush).
      const TYPE2STAGE = { job: 'shooting', shortlist: 'shortlist', fitting: 'fitting', casting: 'casting', option: 'option', priority: 'priority' };
      const activeType = data._activeType; delete data._activeType;
      const prevPrimary = CAT2KEY[schedCat(e)] || '';
      // The chosen tag survives an empty Details box: old text → subject → ' '.
      if (activeType) data[activeType] = (el('d-details') ? el('d-details').value : '') || e[activeType] || data.subject || ' ';
      const typeChanged = activeType !== prevPrimary;
      const becameConfirmed = data.status === 'confirmed' && e.status !== 'confirmed';
      if (typeChanged) {
        data.stage = activeType === 'priority' ? 'priority'                       // an admin block is never a shoot
          : data.status === 'confirmed' ? 'shooting'                              // confirmed booking → Confirmed/Shooting
          : (activeType ? TYPE2STAGE[activeType] : '');
      } else if (becameConfirmed && (activeType || prevPrimary) && activeType !== 'priority' && e.stage !== 'goandsee') {
        data.stage = 'shooting';                                                  // newly confirmed booking → Shooting column
      } else {
        data.stage = e.stage || '';                                               // LOCKED — category stays put
      }
      const r = await api('/api/schedule/' + id, { method: 'PATCH', body: JSON.stringify(data) });
      Object.assign(e, r.entry);
      // A multi-day hold is ONE booking — apply the same edit to its other days
      // (everything except the date), so the hold never ends up half-edited with
      // the Board showing one thing and the calendar another.
      if (e.holdGroup) {
        const sibPatch = { ...data }; delete sibPatch.date;
        const siblings = schedule.filter(x => x.holdGroup === e.holdGroup && x.id !== e.id);
        for (const s of siblings) {
          try { const rs = await api('/api/schedule/' + s.id, { method: 'PATCH', body: JSON.stringify(sibPatch) }); Object.assign(s, rs.entry); }
          catch (_) {}
        }
      }
      done();
    });
    el('d-del').addEventListener('click', async () => {
      if (!confirm('Delete this entry?')) return;
      await api('/api/schedule/' + id, { method: 'DELETE' });
      schedule = schedule.filter(x => x.id !== id);
      done();
    });
    openDrawer();
  }

  ['s-booker', 's-search'].forEach(idc => el(idc).addEventListener('input', renderSchedule));
  // Picking a month from the filter moves the calendar cursor there FIRST, then renders,
  // so the grid and the dropdown always show the same month.
  el('s-month').addEventListener('change', () => {
    const v = el('s-month').value;
    // 'all' → the calendar shows a year overview; keep calMonth on the last real
    // month so Board/Summary (which don't do a 12-month grid) still behave.
    if (v !== 'all') calMonth = v;
    renderSchedule();
  });
  el('s-refresh').addEventListener('click', loadAll);
  el('s-add').addEventListener('click', openAddSchedule);
  // --- Wolf's scouting diary: add/edit his OWN simple entries ---------------
  function scoutEntryDrawer(e) {
    const isNew = !e;
    el('d-title').textContent = isNew ? 'Add scouting plan' : 'Edit scouting plan';
    el('drawer-body').innerHTML = `
      <div class="field"><label>Model / person</label><input id="sc-models" value="${esc(e ? e.models || '' : '')}" placeholder="e.g. OLGA, Natalia Campaz…"></div>
      <div class="field"><label>Doing what</label><input id="sc-subject" value="${esc(e ? e.subject || '' : '')}" placeholder="e.g. KAT Shanghai placement, test shoot, meeting"></div>
      <div class="field"><label>Where</label><input id="sc-place" value="${esc(e ? e.place || '' : '')}" placeholder="e.g. China, Bangkok, Tokyo"></div>
      <div class="field two">
        <div class="field" style="margin:0"><label>From</label><input id="sc-date" type="date" value="${esc(e ? e.date : todayLocal())}"></div>
        <div class="field" style="margin:0"><label>Until <span style="font-weight:400;color:var(--grey);font-size:11px">· optional</span></label><input id="sc-end" type="date" value="${esc(e ? e.endDate || '' : '')}"></div>
      </div>
      <div class="field"><label>Status</label>
        <select id="sc-state">
          <option value="planned" ${e && e.planState === 'planned' ? 'selected' : ''}>Planned (next plan)</option>
          <option value="current" ${!e || e.planState === 'current' || !e.planState ? 'selected' : ''}>Current (happening now)</option>
          <option value="done" ${e && e.planState === 'done' ? 'selected' : ''}>Done</option>
        </select></div>
      <div class="field"><label>Details</label><textarea id="sc-note" rows="3" placeholder="Agency contact, visa notes, conditions…">${esc(e ? e.note || '' : '')}</textarea></div>
      <div class="drawer-actions">
        <button class="btn" id="d-save">${isNew ? 'Add plan' : 'Save changes'}</button>
        ${isNew ? '' : '<button class="link" id="d-del" style="color:var(--declined)">Delete</button>'}
      </div>`;
    el('d-save').addEventListener('click', async () => {
      const data = { date: el('sc-date').value, endDate: el('sc-end').value, models: el('sc-models').value,
        subject: el('sc-subject').value, place: el('sc-place').value, planState: el('sc-state').value,
        note: el('sc-note').value };
      // A manager adding/editing on Wolf's behalf keeps the entry tagged as his.
      if (role !== 'scouter') data.booker = 'Wolf (Scouter)';
      if (!data.date || !(data.models.trim() || data.subject.trim())) { alert('Add a date and who / what.'); return; }
      if (data.endDate && data.endDate < data.date) { alert('"Until" must be after "From".'); return; }
      try {
        if (isNew) { const r = await api('/api/schedule', { method: 'POST', body: JSON.stringify(data) }); schedule.push(r.entry); }
        else { const r = await api('/api/schedule/' + e.id, { method: 'PATCH', body: JSON.stringify(data) }); Object.assign(e, r.entry); }
        buildFilters(); renderSchedule(); if (el('mac-scout-sched')) renderMacScoutSched(); closeDrawer();
      } catch (err) { alert('Could not save: ' + ((err.body && err.body.error) || 'please try again.')); }
    });
    if (!isNew) el('d-del').addEventListener('click', async () => {
      if (!confirm('Delete this entry?')) return;
      try { await api('/api/schedule/' + e.id, { method: 'DELETE' }); } catch (_) {}
      schedule = schedule.filter(x => x.id !== e.id);
      buildFilters(); renderSchedule(); if (el('mac-scout-sched')) renderMacScoutSched(); closeDrawer();
    });
    openDrawer();
  }
  if (el('s-add-scout')) el('s-add-scout').addEventListener('click', () => scoutEntryDrawer(null));
  el('s-cal-btn').addEventListener('click', () => setScheduleView('calendar'));
  el('s-board-btn').addEventListener('click', () => setScheduleView('board'));
  el('s-sum-btn').addEventListener('click', () => setScheduleView('summary'));
  function setScheduleView(v) {
    scheduleView = v;
    el('s-cal-btn').classList.toggle('active', v === 'calendar');
    el('s-board-btn').classList.toggle('active', v === 'board');
    el('s-sum-btn').classList.toggle('active', v === 'summary');
    renderSchedule();
  }

  function openAddSchedule() {
    el('d-title').textContent = 'Add schedule entry';
    el('drawer-body').innerHTML = `
      ${subjectScheduleField(null)}
      ${clientBlockField(null)}
      <div class="field"><label>Models</label><input id="d-models"></div>
      <div id="d-conflict" class="conflict-box" style="display:none"></div>
      ${bookerScheduleField(null)}
      ${timeScheduleField(null)}
      ${shootDaysField(null)}
      ${stagePickerField()}
      <div class="field"><label>Details</label>
        <textarea id="d-details" rows="4" placeholder="Time, location, photographer, client, budget, any details…"></textarea></div>
      <div class="field int-note"><label>📝 Internal note <span style="font-weight:400;color:var(--grey);font-size:11px">· team only</span></label>
        <textarea id="d-sinternalNote" rows="2"></textarea></div>
      <div class="drawer-actions"><button class="btn" id="d-save">Add entry</button></div>`;
    wireClientBlock();
    stageDays = {}; STAGE_BRUSHES.forEach(([b]) => stageDays[b] = new Set());
    activeBrush = 'shooting';
    stagePickerMonth = (calMonth || todayLocal().slice(0, 7));
    renderStagePicker();
    const getDates = () => allStageDates();
    setupConflictCheck(getDates, null);
    el('d-save').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      if (btn.disabled) return;                 // guard: ignore rapid repeat taps
      const dates = getDates();
      if (!dates.length) { alert('⚠ Almost there — pick a stage button (e.g. Go & See), then CLICK the day(s) on the calendar below. The day turns colored when selected.'); return; }
      const details = el('d-details') ? el('d-details').value.trim() : '';
      const base = {
        models: el('d-models').value, subject: schedSubject(), booker: schedBooker(),
        status: schedStatus(), timeStart: schedTimeStart(), timeEnd: schedTimeEnd(),
        shootDays: schedShootDays(), internalNote: el('d-sinternalNote') ? el('d-sinternalNote').value : '',
        leadSource: el('d-sleadSource') ? el('d-sleadSource').value : '',
        clientType: schedClientType(), clientContact: schedClientContact(), clientCategory: schedClientCategory(),
      };
      if (!(base.models || details || base.subject)) { alert('Add a model or some details first.'); return; }
      if (!base.leadSource) { alert('Please pick a Lead source — where did this client come from?'); if (el('d-sleadSource')) el('d-sleadSource').focus(); return; }
      // These guards use a Yes/No popup — clicking "Cancel" means "don't add".
      if (!passesDuplicateGuard({ ...base, casting: details }, dates)) return;
      if (!passesConflictGuard(getDates, null)) return;
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        const created = await createStagedEntries(base, details);
        // Never fail silently: if nothing was created, say so and keep the form open.
        if (!created.length) {
          btn.disabled = false; btn.textContent = 'Add entry';
          alert('Nothing was added — the server did not accept it. Please try again, or refresh the page (Cmd/Ctrl+Shift+R) and retry.');
          return;
        }
        created.forEach(e => schedule.push(e));
        // Jump the view to the day we just added to, so the new entry is visible
        // right away (bookers were confused when they added for another day).
        const firstDay = dates.slice().sort()[0];
        if (firstDay) { dayDate = firstDay; boardAll = false; calMonth = firstDay.slice(0, 7); }
        buildFilters();
        if (scheduleView !== 'board' && scheduleView !== 'calendar') scheduleView = 'board';
        renderSchedule(); closeDrawer();
        toast(`Added ✓  ${created.length} entr${created.length === 1 ? 'y' : 'ies'} on ${fmtNice(firstDay)}`);
      } catch (_) { btn.disabled = false; btn.textContent = 'Add entry'; }
    });
    openDrawer();
  }
  // Small confirmation toast, bottom-center, auto-dismiss.
  function toast(msg) {
    let t = el('mp-toast');
    if (!t) { t = document.createElement('div'); t.id = 'mp-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9998;background:#16211d;color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.25)';
      document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 3200);
  }

  /* ================= 7. DRAWER + TABS ================= */
  function openDrawer()  { el('drawer').classList.add('open'); el('drawer-bg').classList.add('open'); }
  function closeDrawer() { el('drawer').classList.remove('open'); el('drawer-bg').classList.remove('open'); }
  el('d-close').addEventListener('click', closeDrawer);
  el('drawer-bg').addEventListener('click', closeDrawer);

  document.querySelectorAll('.tab').forEach(tab =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const v = tab.dataset.view;
      el('view-jobs').style.display = v === 'jobs' ? 'block' : 'none';
      el('view-schedule').style.display = v === 'schedule' ? 'block' : 'none';
      el('view-models').style.display = v === 'models' ? 'block' : 'none';
      el('view-activity').style.display = v === 'activity' ? 'block' : 'none';
      if (el('view-income')) el('view-income').style.display = v === 'income' ? 'block' : 'none';
      if (el('view-clients')) el('view-clients').style.display = v === 'clients' ? 'block' : 'none';
      if (el('view-mac')) el('view-mac').style.display = v === 'mac' ? 'block' : 'none';
      if (v === 'activity') loadActivity();
      if (v === 'models') loadModels();
      if (v === 'income') loadIncome();
      if (v === 'clients') loadClients().then(renderClients);
      if (v === 'mac') loadMac();
    }));

  /* ============= OTHER INCOME / COMMISSION (Director + Admin only) ===== */
  let income = [];
  const INCOME_KINDS = [['sale', 'Sale'], ['commission', 'Commission'], ['referral', 'Referral'], ['rental', 'Studio rental'], ['mac', 'Mother agency commission'], ['other', 'Other']];
  const kindLabel = k => (INCOME_KINDS.find(x => x[0] === k) || [k, k])[1];
  const inThb = r => { const a = Number(r.amount || 0), c = r.currency || 'THB'; return c === 'THB' ? a : a * (fxRates[c] || 0); };

  async function loadIncome() {
    if (!canSeeMoney()) return;   // hard guard — bookers never fetch this
    try { income = (await api('/api/income')).income || []; } catch (_) { income = []; }
    // Populate the year filter from the data
    const yf = el('in-year');
    if (yf) {
      const years = [...new Set(income.map(r => (r.date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
      const cur = yf.value;
      yf.innerHTML = '<option value="">All time</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
      yf.value = cur;
    }
    renderIncome();
  }

  function renderIncome() {
    const year = el('in-year') ? el('in-year').value : '';
    const kind = el('in-kind') ? el('in-kind').value : '';
    const term = (el('in-search') ? el('in-search').value : '').trim().toLowerCase();
    let list = income.slice();
    if (year) list = list.filter(r => (r.date || '').startsWith(year));
    if (kind) list = list.filter(r => r.kind === kind);
    if (term) list = list.filter(r => [r.source, r.note, kindLabel(r.kind)].join(' ').toLowerCase().includes(term));
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.created || '').localeCompare(a.created || ''));

    el('in-empty').style.display = list.length ? 'none' : 'block';
    el('in-rows').innerHTML = list.map(r => {
      const orig = money(r.amount, r.currency);
      const thb = money(inThb(r));
      const same = (r.currency || 'THB') === 'THB';
      const isMac = r.kind === 'mac';
      const dealCell = isMac
        ? `${esc([r.model, r.agency].filter(Boolean).join(' · ')) || '—'}${r.period ? `<div style="font-size:11px;color:#888">${esc(r.period)}</div>` : ''}`
        : (esc(r.source) || '—');
      const noteCell = isMac
        ? `${r.status ? `<span class="in-kind ${r.status === 'PAID' ? 'k-rental' : 'k-referral'}">${esc(r.status)}</span> ` : ''}${esc(r.paymentInfo || r.note) || ''}`
        : (esc(r.note) || '');
      return `<tr class="in-row" data-id="${r.id}">
        <td>${esc(r.date || '—')}</td>
        <td><span class="in-kind k-${r.kind}">${esc(kindLabel(r.kind))}</span></td>
        <td>${dealCell}</td>
        <td class="num">${orig}${same ? '' : ` <span class="fx-tag">🌐</span>`}</td>
        <td class="num">${thb}</td>
        <td class="in-note">${noteCell}</td>
        <td class="num"><button class="link in-del" data-id="${r.id}" title="Delete" style="color:var(--declined)">✕</button></td>
      </tr>`;
    }).join('');

    // Totals (converted to THB) — overall and by type
    const total = list.reduce((s, r) => s + inThb(r), 0);
    const byKind = INCOME_KINDS.map(([k, lbl]) => {
      const sum = list.filter(r => r.kind === k).reduce((s, r) => s + inThb(r), 0);
      return sum ? `<div class="stat"><div class="n">${money(sum)}</div><div class="l">${lbl}</div></div>` : '';
    }).join('');
    el('in-stats').innerHTML = `<div class="stat money"><div class="n">${money(total)}</div><div class="l">Total (THB) · ${list.length} entr${list.length === 1 ? 'y' : 'ies'}</div></div>${byKind}`;

    // Row actions
    el('in-rows').querySelectorAll('.in-del').forEach(b =>
      b.addEventListener('click', async ev => {
        ev.stopPropagation();
        if (!confirm('Delete this income entry?')) return;
        try { await api('/api/income/' + b.dataset.id, { method: 'DELETE' }); } catch (err) { alert('Could not delete: ' + err.message); return; }
        income = income.filter(x => x.id !== b.dataset.id);
        loadIncome();
      }));
    el('in-rows').querySelectorAll('tr.in-row').forEach(tr =>
      tr.addEventListener('click', () => openIncome(tr.dataset.id)));
  }

  function openIncome(id) {
    const r = id ? income.find(x => x.id === id) : null;
    el('d-title').textContent = r ? 'Edit income' : 'Add income';
    const CURS = ['THB', 'USD', 'EUR', 'CNY'];
    const MAC_STATUS = ['PAID', 'Pending', 'Postponed', 'OFF'];
    const cur = (v) => r && r[v] ? withCommas(String(r[v])) : '';
    el('drawer-body').innerHTML = `
      <div class="field"><label>Date</label><input id="in-f-date" type="date" value="${esc(r ? r.date : todayLocal())}"></div>
      <div class="field"><label>Type</label>
        <select id="in-f-kind">${INCOME_KINDS.map(([k, lbl]) => `<option value="${k}" ${r && r.kind === k ? 'selected' : ''}>${lbl}</option>`).join('')}</select></div>

      <div id="in-mac" style="display:none">
        <div class="client-block">
          <div class="cb-head">Mother Agency Commission — details</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="field" style="margin:0"><label class="cb-lbl">Model</label><input id="in-f-model" value="${esc(r ? r.model : '')}" placeholder="model name"></div>
            <div class="field" style="margin:0"><label class="cb-lbl">Agency</label><input id="in-f-agency" value="${esc(r ? r.agency : '')}" placeholder="e.g. KAT China"></div>
          </div>
          <label class="cb-lbl">Work period</label><input id="in-f-period" value="${esc(r ? r.period : '')}" placeholder="e.g. 10th Oct 2024 - 13th Jan 2025">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px">
            <div class="field" style="margin:0"><label class="cb-lbl">Model's amount (abroad)</label><input id="in-f-modelAmount" inputmode="decimal" value="${cur('modelAmount')}" placeholder="0"></div>
            <div class="field" style="margin:0"><label class="cb-lbl">Expense</label><input id="in-f-expense" inputmode="decimal" value="${cur('expense')}" placeholder="0"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px">
            <div class="field" style="margin:0"><label class="cb-lbl">Advance cost</label><input id="in-f-advanceCost" inputmode="decimal" value="${cur('advanceCost')}" placeholder="0"></div>
            <div class="field" style="margin:0"><label class="cb-lbl">Status</label><select id="in-f-status"><option value="">—</option>${MAC_STATUS.map(s => `<option ${r && r.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
          </div>
          <label class="cb-lbl">Payment info</label><input id="in-f-paymentInfo" value="${esc(r ? r.paymentInfo : '')}" placeholder="e.g. MAC paid to Alex via QR 11.03.2025">
        </div>
      </div>

      <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
        <div class="field"><label><span id="in-amt-lbl">Amount</span> <span id="in-amt-hint" style="font-weight:400;color:var(--grey);font-size:11px"></span></label><input id="in-f-amount" inputmode="decimal" value="${esc(r ? withCommas(String(r.amount)) : '')}" placeholder="0"></div>
        <div class="field"><label>Currency</label>
          <select id="in-f-cur">${CURS.map(c => `<option value="${c}" ${r && r.currency === c ? 'selected' : (!r && c === 'THB' ? 'selected' : '')}>${c}</option>`).join('')}</select></div>
      </div>
      <div id="in-generic"><div class="field"><label>Source / deal</label><input id="in-f-source" value="${esc(r ? r.source : '')}" placeholder="Client, brand, or deal name"></div></div>
      <div class="field"><label>Note</label><textarea id="in-f-note" rows="2" placeholder="Any detail">${esc(r ? r.note : '')}</textarea></div>
      <div class="drawer-actions">
        <button class="btn" id="in-f-save">${r ? 'Save changes' : 'Add income'}</button>
        ${r ? '<button class="link" id="in-f-del" style="color:var(--declined)">Delete</button>' : ''}
      </div>`;
    // Comma-format every money input.
    ['in-f-amount', 'in-f-modelAmount', 'in-f-expense', 'in-f-advanceCost'].forEach(idc => {
      const e = el(idc); if (e) e.addEventListener('input', () => { e.value = withCommas(e.value); });
    });
    // Show the MAC ledger fields only for Mother-agency-commission; auto-fill the
    // commission at 50% of the model's amount (editable) until touched by hand.
    let amountTouched = !!r;
    el('in-f-amount').addEventListener('input', () => { amountTouched = true; });
    const applyKind = () => {
      const mac = el('in-f-kind').value === 'mac';
      el('in-mac').style.display = mac ? 'block' : 'none';
      el('in-generic').style.display = mac ? 'none' : 'block';
      el('in-amt-lbl').textContent = mac ? 'MAC commission (income)' : 'Amount';
      el('in-amt-hint').textContent = mac ? '· 50% of model amount (edit if different)' : '';
    };
    el('in-f-kind').addEventListener('change', applyKind);
    applyKind();
    if (el('in-f-modelAmount')) el('in-f-modelAmount').addEventListener('input', () => {
      if (amountTouched || el('in-f-kind').value !== 'mac') return;
      const ma = Number(String(el('in-f-modelAmount').value).replace(/[^\d.]/g, '')) || 0;
      el('in-f-amount').value = ma ? withCommas(String(Math.round(ma * 0.5))) : '';
    });
    el('in-f-save').addEventListener('click', async () => {
      const payload = {
        date: el('in-f-date').value,
        kind: el('in-f-kind').value,
        amount: el('in-f-amount').value,
        currency: el('in-f-cur').value,
        source: el('in-f-source') ? el('in-f-source').value : '',
        note: el('in-f-note').value,
        model: el('in-f-model') ? el('in-f-model').value : '',
        agency: el('in-f-agency') ? el('in-f-agency').value : '',
        period: el('in-f-period') ? el('in-f-period').value : '',
        modelAmount: el('in-f-modelAmount') ? el('in-f-modelAmount').value : '',
        expense: el('in-f-expense') ? el('in-f-expense').value : '',
        advanceCost: el('in-f-advanceCost') ? el('in-f-advanceCost').value : '',
        status: el('in-f-status') ? el('in-f-status').value : '',
        paymentInfo: el('in-f-paymentInfo') ? el('in-f-paymentInfo').value : '',
      };
      try {
        if (r) await api('/api/income/' + r.id, { method: 'PATCH', body: JSON.stringify(payload) });
        else await api('/api/income', { method: 'POST', body: JSON.stringify(payload) });
        closeDrawer();
        loadIncome();
      } catch (e) { alert('Could not save: ' + (e.message || e)); }
    });
    if (r) el('in-f-del').addEventListener('click', async () => {
      if (!confirm('Delete this income entry?')) return;
      try { await api('/api/income/' + r.id, { method: 'DELETE' }); } catch (err) { alert('Could not delete: ' + err.message); return; }
      closeDrawer();
      income = income.filter(x => x.id !== r.id);
      loadIncome();
    });
    openDrawer();
  }

  if (el('in-add')) el('in-add').addEventListener('click', () => openIncome(null));
  if (el('in-refresh')) el('in-refresh').addEventListener('click', loadIncome);
  ['in-year', 'in-kind', 'in-search'].forEach(idc => { if (el(idc)) el(idc).addEventListener('input', renderIncome); });

  /* ============= CLIENTS CRM (Director + Admin only) ============= */
  const clientKey = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let clientRowsCache = [];   // the profiles currently shown — used by export + detail drawer
  let clientRecords = [];     // clients added directly (merged with job history)
  async function loadClients() {
    if (!canSeeMoney()) return;
    try { clientRecords = (await api('/api/clients')).clients || []; } catch (_) { clientRecords = []; }
  }
  // Whole months since a YYYY-MM-DD date (big number if never / no date).
  function monthsAgo(d) {
    if (!isISODate(d)) return 9999;
    const t = new Date(d + 'T00:00:00'), n = new Date(todayLocal() + 'T00:00:00');
    return Math.max(0, Math.round((n - t) / (1000 * 60 * 60 * 24 * 30.44)));
  }
  const agoLabel = m => m >= 9999 ? '' : m < 1 ? 'this month' : m === 1 ? '1 mo ago' : m + ' mo ago';

  // Build one rich profile per client from their jobs + confirmation details.
  function clientProfiles(pool) {
    const groups = {};
    pool.forEach(j => { const k = clientKey(j.client); (groups[k] = groups[k] || []).push(j); });
    // most-recent non-empty value across a client's jobs (confirmations hold the detail)
    const best = (js, keys) => {
      for (const j of js.slice().sort((a, b) => (b.jobDate || '').localeCompare(a.jobDate || '')))
        for (const k of keys) if (String(j[k] || '').trim()) return String(j[k]).trim();
      return '';
    };
    const profiles = Object.entries(groups).map(([key, js]) => {
      const names = {}; js.forEach(j => { const n = (j.client || '').trim(); if (n) names[n] = (names[n] || 0) + 1; });
      const name = Object.entries(names).sort((a, b) => b[1] - a[1])[0][0];
      const dates = js.map(j => j.jobDate).filter(Boolean).sort();
      const last = dates[dates.length - 1] || '';
      const catCount = {}; js.forEach(j => { const c = (j.clientCategory || '').trim(); if (c) catCount[c] = (catCount[c] || 0) + 1; });
      const category = (Object.entries(catCount).sort((a, b) => b[1] - a[1])[0] || [''])[0];
      return {
        key, name, jobs: js, count: js.length, category,
        company: best(js, ['companyName']), taxId: best(js, ['clientTaxId']),
        address: best(js, ['companyAddress']),
        person: best(js, ['contactPerson', 'clientName']),
        phone: best(js, ['contactNumber', 'phone']),
        email: best(js, ['clientEmail', 'email']),
        sources: distinct(js.map(j => j.leadSource).filter(Boolean)),
        first: dates[0] || '', last,
        monthsSince: monthsAgo(last),
        total: js.reduce((s, j) => s + toThb(j), 0),
      };
    });
    // Merge in directly-added client records (they may or may not have jobs yet).
    const byKey = {}; profiles.forEach(p => { byKey[p.key] = p; });
    clientRecords.forEach(rec => {
      const key = clientKey(rec.name); if (!key) return;
      let p = byKey[key];
      if (!p) { p = { key, name: rec.name, jobs: [], count: 0, category: '', company: '', taxId: '', address: '', person: '', phone: '', email: '', sources: [], first: '', last: '', monthsSince: 9999, total: 0 }; byKey[key] = p; profiles.push(p); }
      p.recordId = rec.id;
      if (rec.name) p.name = rec.name;                 // record spelling wins
      p.company = rec.company || p.company;
      p.taxId = rec.taxId || p.taxId;
      p.address = rec.address || p.address;
      p.person = rec.contactPerson || p.person;
      p.phone = rec.phone || p.phone;
      p.email = rec.email || p.email;
      if (rec.clientCategory) p.category = rec.clientCategory;
      if (rec.leadSource && !p.sources.includes(rec.leadSource)) p.sources.unshift(rec.leadSource);
      if (rec.note) p.note = rec.note;
    });
    return profiles;
  }

  function renderClients() {
    if (!canSeeMoney()) { el('view-clients').innerHTML = '<p style="padding:20px;color:var(--grey)">Director / Admin only.</p>'; return; }
    const srcSel = el('cl-source');
    if (srcSel && srcSel.options.length <= 1) srcSel.innerHTML = '<option value="">All sources</option>' + LEAD_SOURCES.map(s => `<option value="${s}">${SOURCE_ICON[s] || ''} ${s}</option>`).join('');
    const catSel = el('cl-cat');
    if (catSel && catSel.options.length <= 1) catSel.innerHTML = '<option value="">All types</option>' + CLIENT_CATEGORIES.map(c => `<option value="${c}">${CAT_ICON[c] || ''} ${c}</option>`).join('');
    const ySel = el('cl-year');
    if (ySel && ySel.options.length <= 1) {
      const years = distinct(jobs.map(j => String(j.jobDate || '').slice(0, 4)).filter(y => /^\d{4}$/.test(y))).sort().reverse();
      ySel.innerHTML = '<option value="">All time</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
    }
    const term = (el('cl-search').value || '').trim().toLowerCase();
    const srcF = el('cl-source').value;
    const yearF = el('cl-year').value;
    const sortBy = el('cl-sort').value;

    const pool = jobs.filter(j => (j.client || '').trim()
      && (!yearF || String(j.jobDate || '').startsWith(yearF))
      && (!srcF || j.leadSource === srcF));

    // Leads-by-source summary.
    const srcCount = {};
    pool.forEach(j => { const s = j.leadSource || '—'; srcCount[s] = (srcCount[s] || 0) + 1; });
    const srcBar = Object.entries(srcCount).sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${s === '—' ? 'no source' : (SOURCE_ICON[s] || '') + ' ' + s}</div></div>`).join('');

    const followF = el('cl-follow') ? Number(el('cl-follow').value) : 0;
    const catF = el('cl-cat') ? el('cl-cat').value : '';
    let rows = clientProfiles(pool);
    if (catF) rows = rows.filter(r => r.category === catF);
    if (term) rows = rows.filter(r => (r.name + ' ' + r.company + ' ' + r.person + ' ' + r.phone + ' ' + r.email + ' ' + r.sources.join(' ') + ' ' + r.category).toLowerCase().includes(term));
    if (followF) rows = rows.filter(r => r.monthsSince >= followF && r.monthsSince < 9999);   // dormant clients to chase
    rows.sort((a, b) =>
      sortBy === 'jobs' ? b.count - a.count :
      sortBy === 'recent' ? (b.last || '').localeCompare(a.last || '') :
      sortBy === 'dormant' ? b.monthsSince - a.monthsSince :
      sortBy === 'name' ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) :
      b.total - a.total);
    clientRowsCache = rows;

    el('cl-srcstats').innerHTML = `<div class="stat money"><div class="n">${rows.length}</div><div class="l">Clients · ${pool.length} jobs</div></div>${srcBar}`;
    el('cl-empty').style.display = rows.length ? 'none' : 'block';
    el('cl-rows').innerHTML = rows.map(r => `
      <tr class="cl-row" data-key="${esc(r.key)}">
        <td><b>${esc(r.name)}</b>${r.category ? ` <span class="src-badge cat">${CAT_ICON[r.category] || ''} ${esc(r.category)}</span>` : ''}${r.company && clientKey(r.company) !== r.key ? `<div style="font-size:11px;color:#888">${esc(r.company)}</div>` : ''}${r.count > 1 ? ' <span class="src-badge">🔁 returning</span>' : ''}</td>
        <td>${r.sources.length ? r.sources.map(s => `<span class="src-badge">${SOURCE_ICON[s] || ''} ${esc(s)}</span>`).join(' ') : '<span class="src-badge none">no source</span>'}</td>
        <td class="num">${r.count}</td>
        <td>${esc(r.first) || '—'}</td>
        <td>${esc(r.last) || '—'}${r.last ? `<div class="cl-ago ${r.monthsSince >= 6 ? 'stale' : ''}">${agoLabel(r.monthsSince)}</div>` : ''}</td>
        <td class="num money">${money(r.total)}</td>
        <td style="color:#666;font-size:12px">${[r.person, r.phone, r.email].filter(Boolean).map(esc).join(' · ') || '—'}</td>
      </tr>`).join('');
    el('cl-rows').querySelectorAll('.cl-row').forEach(tr =>
      tr.addEventListener('click', () => openClientDetail(tr.dataset.key)));
  }

  // Full client profile drawer — company/tax/address/contact + their job history.
  function openClientDetail(key) {
    const p = clientRowsCache.find(x => x.key === key); if (!p) return;
    el('d-title').textContent = p.name;
    const line = (label, val) => val ? `<div class="cd-line"><span class="cd-l">${label}</span><span class="cd-v">${esc(val)}</span></div>` : '';
    const jobsSorted = p.jobs.slice().sort((a, b) => (b.jobDate || '').localeCompare(a.jobDate || ''));
    el('drawer-body').innerHTML = `
      <div class="client-block">
        <div class="cb-head">Client details ${p.count > 1 ? '· 🔁 returning' : ''}</div>
        ${line('Client type', p.category ? (CAT_ICON[p.category] || '') + ' ' + p.category : '')}
        ${line('Company', p.company)}
        ${line('Tax ID', p.taxId)}
        ${line('Address', p.address)}
        ${line('Contact person', p.person)}
        ${line('Phone', p.phone)}
        ${line('Email', p.email)}
        ${line('Source(s)', p.sources.join(', '))}
        <div class="cd-line"><span class="cd-l">Last booked</span><span class="cd-v">${p.last ? esc(p.last) + ' · ' + agoLabel(p.monthsSince) : '—'}</span></div>
        <div class="cd-line"><span class="cd-l">Total value</span><span class="cd-v money"><b>${money(p.total)}</b></span></div>
      </div>
      <div class="drawer-actions" style="margin:0 0 14px">
        <button class="btn ghost" id="cd-edit">✏️ ${p.recordId ? 'Edit client' : 'Save as client record'}</button>
        ${p.email ? `<a class="link" style="text-decoration:none;color:var(--teal)" href="mailto:${esc(p.email)}?subject=${encodeURIComponent('MP Models — great to work with you again')}&body=${encodeURIComponent('Dear ' + (p.person || p.name) + ',\n\n')}">✉ Follow-up email</a>` : ''}
        ${p.recordId ? '<button class="link" id="cd-del" style="color:var(--declined)">Delete client</button>' : ''}
      </div>
      <div class="sect-h">Jobs (${p.count})</div>
      <table class="cd-jobs"><thead><tr><th>Date</th><th>Code</th><th>Title</th><th class="num money">Value</th></tr></thead><tbody>
        ${jobsSorted.map(j => `<tr><td>${esc(j.jobDate) || '—'}</td><td>${esc(j.jobId || j.jobIdNonTax) || '—'}</td><td>${esc(j.jobTitle) || '—'}</td><td class="num money">${budgetCell(j)}</td></tr>`).join('')}
      </tbody></table>`;
    // Edit → open the record form (prefilled from the record, or from the job-derived profile).
    el('cd-edit').addEventListener('click', () => openClientForm(p.recordId || null, p));
    if (p.recordId) el('cd-del').addEventListener('click', async () => {
      if (!confirm('Delete this client record?\n\n(Their job history stays — only the manually-added contact record is removed.)')) return;
      try { await api('/api/clients/' + p.recordId, { method: 'DELETE' }); } catch (err) { alert('Could not delete: ' + err.message); return; }
      clientRecords = clientRecords.filter(x => x.id !== p.recordId);
      closeDrawer(); renderClients();
    });
    openDrawer();
  }

  // Add / edit a standalone client record. prefill = a profile to seed fields from.
  function openClientForm(recordId, prefill) {
    const rec = recordId ? clientRecords.find(x => x.id === recordId) : null;
    const src = rec || prefill || {};
    el('d-title').textContent = rec ? 'Edit client' : 'Add client';
    const f = (label, id, val, ph) => `<div class="field"><label>${label}</label><input id="cf-${id}" value="${esc(val || '')}" placeholder="${ph || ''}"></div>`;
    el('drawer-body').innerHTML = `
      <div class="field"><label>Client name <span style="color:var(--declined);font-weight:400;font-size:11px">· required</span></label>
        <input id="cf-name" value="${esc(rec ? rec.name : (src.name || ''))}" placeholder="as bookers type it"></div>
      <div class="field two">
        <div class="field" style="margin:0"><label>Client type</label>
          <select id="cf-clientCategory"><option value="">— type —</option>${CLIENT_CATEGORIES.map(c => `<option value="${esc(c)}" ${(src.clientCategory || src.category || '') === c ? 'selected' : ''}>${CAT_ICON[c] || ''} ${esc(c)}</option>`).join('')}</select></div>
        <div class="field" style="margin:0"><label>Lead source</label>
          <select id="cf-leadSource"><option value="">— source —</option>${LEAD_SOURCES.map(s => `<option value="${esc(s)}" ${(src.leadSource || (src.sources && src.sources[0]) || '') === s ? 'selected' : ''}>${SOURCE_ICON[s] || ''} ${esc(s)}</option>`).join('')}</select></div>
      </div>
      ${f('Company name', 'company', src.company)}
      <div class="field two">${f('Tax ID', 'taxId', src.taxId)}${f('Contact person', 'contactPerson', src.contactPerson || src.person)}</div>
      <div class="field two">${f('Phone', 'phone', src.phone)}${f('Email', 'email', src.email)}</div>
      ${f('Address', 'address', src.address)}
      <div class="field"><label>Note</label><textarea id="cf-note" rows="2">${esc(src.note || '')}</textarea></div>
      <div class="drawer-actions">
        <button class="btn" id="cf-save">${rec ? 'Save' : 'Add client'}</button>
        ${rec ? '<button class="link" id="cf-del" style="color:var(--declined)">Delete</button>' : ''}
      </div>`;
    el('cf-save').addEventListener('click', async () => {
      const data = { name: el('cf-name').value.trim(), company: el('cf-company').value, taxId: el('cf-taxId').value,
        address: el('cf-address').value, contactPerson: el('cf-contactPerson').value, phone: el('cf-phone').value,
        email: el('cf-email').value, leadSource: el('cf-leadSource').value, clientCategory: el('cf-clientCategory').value, note: el('cf-note').value };
      if (!data.name) { alert('Please enter a client name.'); return; }
      try {
        if (rec) { const r = await api('/api/clients/' + rec.id, { method: 'PATCH', body: JSON.stringify(data) }); Object.assign(rec, r.client); }
        else { const r = await api('/api/clients', { method: 'POST', body: JSON.stringify(data) }); clientRecords.push(r.client); }
        closeDrawer(); renderClients();
        toast(rec ? 'Client saved ✓' : 'Client added ✓');
      } catch (e) { alert('Could not save: ' + (e.message || e)); }
    });
    if (rec) el('cf-del').addEventListener('click', async () => {
      if (!confirm('Delete this client record?')) return;
      try { await api('/api/clients/' + rec.id, { method: 'DELETE' }); } catch (err) { alert('Could not delete: ' + err.message); return; }
      clientRecords = clientRecords.filter(x => x.id !== rec.id);
      closeDrawer(); renderClients();
    });
    openDrawer();
  }

  function exportClients() {
    const rows = clientRowsCache;
    if (!rows.length) { alert('No clients to export.'); return; }
    const header = ['Client', 'Client type', 'Company name', 'Tax ID', 'Address', 'Contact person', 'Phone', 'Email', 'Source(s)', 'Returning?', 'Jobs', 'First job', 'Last job', 'Total value (THB)'];
    const data = rows.map(r => [r.name, r.category, r.company, r.taxId, r.address, r.person, r.phone, r.email, r.sources.join(' / '), r.count > 1 ? 'Yes' : '', r.count, r.first, r.last, Math.round(r.total)]);
    const esc2 = v => { v = String(v == null ? '' : v);
      if (/^[=+\-@]/.test(v)) v = "'" + v;               // neutralise spreadsheet formula injection (=,+,-,@)
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const csv = [header, ...data].map(r => r.map(esc2).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'MP-clients-' + todayLocal() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${rows.length} clients ✓`);
  }

  ['cl-search', 'cl-source', 'cl-cat', 'cl-year', 'cl-sort', 'cl-follow'].forEach(idc => { if (el(idc)) el(idc).addEventListener('input', renderClients); });
  if (el('cl-refresh')) el('cl-refresh').addEventListener('click', () => loadAll().then(loadClients).then(renderClients));
  if (el('cl-export')) el('cl-export').addEventListener('click', exportClients);
  if (el('cl-add')) el('cl-add').addEventListener('click', () => openClientForm(null));

  /* ============= MOTHER AGENCY (MAC) LEDGER — scouter + managers ===== */
  let macRecords = [];
  const MAC_STATUSES = ['PAID', 'To be paid', 'Pending', 'Postponed', 'OFF', 'In town', 'To be seen'];
  const macIsScouter = () => role === 'scouter';
  async function loadMac() {
    try { macRecords = (await api('/api/mac')).mac || []; } catch (_) { macRecords = []; }
    const yf = el('mac-year');
    if (yf) {
      const cur = yf.value;
      const years = distinct(macRecords.map(r => r.year || (r.created || '').slice(0, 4)).filter(Boolean)).sort().reverse();
      yf.innerHTML = '<option value="">All years</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
      yf.value = cur;
    }
    const of = el('mac-owner');
    if (of && !macIsScouter()) {
      const cur = of.value;
      const owners = distinct(macRecords.map(r => r.ownerName || r.owner).filter(Boolean));
      of.innerHTML = '<option value="">All scouters</option>' + owners.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
      of.value = cur;
    }
    renderMac();
  }
  // Wolf's scouting schedule ON the Mother Agency page — two sections, one
  // page (Lisa). Managers see and can edit everything; Wolf edits his own.
  // Gantt: rows = models, bars = placements (From→Until), colours = status.
  function scoutGanttHtml(list) {
    const items = list.filter(e => e.date).map(e => ({
      ...e,
      s: new Date(e.date + 'T00:00:00'),
      t: new Date((e.endDate && e.endDate >= e.date ? e.endDate : e.date) + 'T00:00:00'),
    }));
    if (!items.length) return '';
    let min = new Date(Math.min.apply(null, items.map(i => i.s)));
    let max = new Date(Math.max.apply(null, items.map(i => i.t)));
    const now = new Date();
    if (max < now) max = now;
    min = new Date(min.getFullYear(), min.getMonth(), 1);
    max = new Date(max.getFullYear(), max.getMonth() + 2, 0);   // pad one month ahead
    const span = max - min;
    const months = [];
    for (let d = new Date(min); d <= max; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(new Date(d));
    const pct = d => (d - min) / span * 100;
    const COLORS = { planned: '#c9973a', current: '#2f8f83', done: '#a7adb3' };
    const byModel = {};
    items.forEach(i => { const k = (String(i.models || '').split(/[,\n]/)[0] || '—').trim() || '—'; (byModel[k] = byModel[k] || []).push(i); });
    const head = months.map(m =>
      `<div style="flex:1;border-left:1px solid #e8e8e8;font-size:9.5px;color:#999;padding-left:3px;overflow:hidden">${m.toLocaleString('en', { month: 'short' })}${m.getMonth() === 0 || m === months[0] ? ' ' + String(m.getFullYear()).slice(2) : ''}</div>`).join('');
    const rows = Object.keys(byModel).sort().map(name => {
      const bars = byModel[name].map(i => {
        const l = pct(i.s), w = Math.max(2, pct(i.t) - l + 100 / months.length / 30);
        const c = COLORS[i.planState] || COLORS.current;
        const lbl = [i.subject, i.place].filter(Boolean).join(' · ');
        return `<div class="scout-row" data-id="${i.id}" title="${esc(name + ' — ' + lbl + ' (' + i.date + (i.endDate ? ' → ' + i.endDate : '') + ')')}"
          style="position:absolute;left:${l.toFixed(2)}%;width:${w.toFixed(2)}%;top:3px;height:18px;background:${c};border-radius:4px;color:#fff;font-size:9.5px;line-height:18px;padding:0 5px;overflow:hidden;white-space:nowrap;cursor:pointer">${esc(lbl)}</div>`;
      }).join('');
      return `<div style="display:flex;align-items:center;margin:2px 0">
        <div style="width:110px;flex:none;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(name)}">${esc(name)}</div>
        <div style="flex:1;position:relative;height:24px;background:#fbfbfb;border-left:1px solid #e8e8e8">${bars}</div></div>`;
    }).join('');
    const tl = pct(now);
    return `<div style="margin-top:10px">
      <div style="display:flex"><div style="width:110px;flex:none"></div><div style="flex:1;display:flex">${head}</div></div>
      <div style="position:relative">${rows}
        ${tl >= 0 && tl <= 100 ? `<div style="position:absolute;top:0;bottom:0;left:calc(110px + (100% - 110px)*${(tl / 100).toFixed(4)});width:2px;background:#c74436;opacity:.65" title="Today"></div>` : ''}
      </div>
      <div style="display:flex;gap:14px;margin-top:6px;font-size:10.5px;color:#777">
        <span><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#2f8f83"></span> Current</span>
        <span><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#c9973a"></span> Planned</span>
        <span><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#a7adb3"></span> Done</span>
      </div></div>`;
  }
  function renderMacScoutSched() {
    const host = el('mac-scout-sched'); if (!host) return;
    const mine = schedule.filter(e => e.createdBy === 'scouter@mpmodelsbkk.com' || /scouter/i.test(String(e.booker || '')));
    const sorted = mine.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const row = e => `<tr class="scout-row" data-id="${e.id}" style="cursor:pointer">
      <td>${esc(e.date)}${e.endDate ? ' → ' + esc(e.endDate) : ''}</td>
      <td><b>${esc(e.models || '')}</b></td><td>${esc(e.subject || '')}</td><td>${esc(e.place || '')}</td>
      <td>${esc(e.planState || '')}</td>
      <td style="color:#8a8a8a">${esc(String(e.note || '').slice(0, 60))}</td></tr>`;
    host.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <h3 style="margin:0;font-size:14px">🧭 Scouting Schedule — Wolf</h3>
        <button class="btn" id="mac-scout-add">+ Add plan</button>
      </div>
      ${mine.length ? scoutGanttHtml(sorted) + `
        <details style="margin-top:8px"><summary style="font-size:11.5px;color:#777;cursor:pointer">All plans as a list</summary>
        <div class="table-scroll"><table>
        <thead><tr><th>From → until</th><th>Model / person</th><th>Doing what</th><th>Where</th><th>Status</th><th>Details</th></tr></thead>
        <tbody>${sorted.map(row).join('')}</tbody></table></div></details>`
        : '<p style="color:#999;font-size:12.5px;margin:4px 0">No plans yet — add where each model is going, with whom, from when until when.</p>'}`;
    const add = el('mac-scout-add');
    if (add) add.addEventListener('click', () => scoutEntryDrawer(null));
    host.querySelectorAll('.scout-row').forEach(tr => tr.addEventListener('click', () => {
      const e = schedule.find(x => x.id === tr.dataset.id); if (!e) return;
      if (role === 'scouter') editScheduleEntry(e.id);   // own-entry guard inside
      else scoutEntryDrawer(e);                          // managers edit any
    }));
  }
  // Sub-tabs on the Mother Agency page: 1. MAC ledger  2. Placement schedule.
  // Wolf lands on his planning board; managers land on the money.
  let macSeg = null;   // resolved on first render
  function applyMacSeg() {
    if (macSeg === null) macSeg = role === 'scouter' ? 'sched' : 'ledger';
    const lw = el('mac-ledger-wrap'), sw = el('mac-sched-wrap');
    if (lw) lw.style.display = macSeg === 'ledger' ? 'block' : 'none';
    if (sw) sw.style.display = macSeg === 'sched' ? 'block' : 'none';
    const bl = el('mac-seg-ledger'), bs = el('mac-seg-sched');
    if (bl) bl.classList.toggle('active', macSeg === 'ledger');
    if (bs) bs.classList.toggle('active', macSeg === 'sched');
  }
  if (el('mac-seg-ledger')) el('mac-seg-ledger').addEventListener('click', () => { macSeg = 'ledger'; applyMacSeg(); });
  if (el('mac-seg-sched')) el('mac-seg-sched').addEventListener('click', () => { macSeg = 'sched'; applyMacSeg(); renderMacScoutSched(); });
  function renderMac() {
    applyMacSeg();
    renderMacScoutSched();
    const yearF = el('mac-year') ? el('mac-year').value : '';
    const ownerF = el('mac-owner') ? el('mac-owner').value : '';
    const term = (el('mac-search') ? el('mac-search').value : '').trim().toLowerCase();
    let list = macRecords.slice();
    if (yearF) list = list.filter(r => (r.year || (r.created || '').slice(0, 4)) === yearF);
    if (ownerF) list = list.filter(r => (r.ownerName || r.owner) === ownerF);
    if (term) list = list.filter(r => [r.model, r.agency, r.period, r.status, r.paymentInfo, r.note].join(' ').toLowerCase().includes(term));
    list.sort((a, b) => (a.created || '').localeCompare(b.created || ''));   // ledger order
    macRowsCache = list;
    el('mac-empty').style.display = list.length ? 'none' : 'block';
    const stCls = s => /paid/i.test(s) && !/to be/i.test(s) ? 'ok' : /off|postpon/i.test(s) ? 'off' : 'wait';
    el('mac-rows').innerHTML = list.map((r, i) => `
      <tr class="mac-row" data-id="${r.id}">
        <td>${i + 1}</td>
        <td>${esc(r.period) || '—'}</td>
        <td><b>${esc(r.model) || '—'}</b>${!macIsScouter() && r.ownerName ? `<div style="font-size:10.5px;color:#999">${esc(r.ownerName)}</div>` : ''}</td>
        <td>${esc(r.agency) || '—'}</td>
        <td class="num">${r.amount ? money(r.amount) : '—'}</td>
        <td class="num">${r.gross ? money(r.gross) : '—'}</td>
        <td class="num"><b>${r.commission ? money(r.commission) : '—'}</b></td>
        <td class="num">${r.expense ? money(r.expense) : ''}</td>
        <td>${r.status ? `<span class="mac-st ${stCls(r.status)}">${esc(r.status)}</span>` : ''}</td>
        <td style="font-size:11.5px;color:#555">${esc(r.paymentInfo) || ''}</td>
        <td class="num"><button class="link mac-del" data-id="${r.id}" title="Delete" style="color:var(--declined)">✕</button></td>
      </tr>`).join('');
    const sumGross = list.reduce((s, r) => s + Number(r.gross || 0), 0);
    const sumComm = list.reduce((s, r) => s + Number(r.commission || 0), 0);
    const paidComm = list.filter(r => /paid/i.test(r.status) && !/to be/i.test(r.status)).reduce((s, r) => s + Number(r.commission || 0), 0);
    el('mac-stats').innerHTML = `
      <div class="stat"><div class="n">${list.length}</div><div class="l">Records</div></div>
      <div class="stat"><div class="n">${money(sumGross)}</div><div class="l">Gross MAC (10%)</div></div>
      <div class="stat money"><div class="n">${money(sumComm)}</div><div class="l">Wolf's share (5%)</div></div>
      <div class="stat"><div class="n">${money(paidComm)}</div><div class="l">Paid to Wolf</div></div>`;
    el('mac-rows').querySelectorAll('.mac-del').forEach(b => b.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!confirm('Delete this record?')) return;
      try { await api('/api/mac/' + b.dataset.id, { method: 'DELETE' }); } catch (err) { alert('Could not delete: ' + err.message); return; }
      macRecords = macRecords.filter(x => x.id !== b.dataset.id); renderMac();
    }));
    el('mac-rows').querySelectorAll('.mac-row').forEach(tr => tr.addEventListener('click', () => openMacForm(tr.dataset.id)));
  }
  let macRowsCache = [];
  function openMacForm(id) {
    const r = id ? macRecords.find(x => x.id === id) : null;
    el('d-title').textContent = r ? 'Edit record' : 'Add record';
    const cur = v => r && r[v] ? withCommas(String(r[v])) : '';
    el('drawer-body').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>Model</label><input id="mc-model" value="${esc(r ? r.model : '')}"></div>
        <div class="field"><label>Agency</label><input id="mc-agency" value="${esc(r ? r.agency : '')}" placeholder="e.g. KAT China"></div>
      </div>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
        <div class="field"><label>Work period</label><input id="mc-period" value="${esc(r ? r.period : '')}" placeholder="e.g. 10th Oct 2024 - 13th Jan 2025"></div>
        <div class="field"><label>Year</label><input id="mc-year" value="${esc(r ? r.year : String(new Date().getFullYear()))}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>Model's amount <span style="font-weight:400;color:#999;font-size:11px">· model's earning</span></label><input id="mc-amount" inputmode="decimal" value="${cur('amount')}" placeholder="0"></div>
        <div class="field"><label>Gross MAC <span style="font-weight:400;color:#999;font-size:11px">· 10%</span></label><input id="mc-gross" inputmode="decimal" value="${cur('gross')}" placeholder="0"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>Wolf's share <span style="font-weight:400;color:#999;font-size:11px">· 5% (half of gross)</span></label><input id="mc-commission" inputmode="decimal" value="${cur('commission')}" placeholder="0"></div>
        <div class="field"><label>Expense</label><input id="mc-expense" inputmode="decimal" value="${cur('expense')}" placeholder="0"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>Advance cost</label><input id="mc-advanceCost" inputmode="decimal" value="${cur('advanceCost')}" placeholder="0"></div>
        <div class="field"><label>Status</label><select id="mc-status"><option value="">—</option>${MAC_STATUSES.map(s => `<option ${r && r.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Payment info</label><input id="mc-paymentInfo" value="${esc(r ? r.paymentInfo : '')}" placeholder="e.g. MAC paid to Wolf's Wechat 11.03.2025"></div>
      <div class="field"><label>Note</label><textarea id="mc-note" rows="2">${esc(r ? r.note : '')}</textarea></div>
      <div class="drawer-actions"><button class="btn" id="mc-save">${r ? 'Save' : 'Add record'}</button>${r ? '<button class="link" id="mc-del" style="color:var(--declined)">Delete</button>' : ''}</div>`;
    ['mc-amount', 'mc-gross', 'mc-commission', 'mc-expense', 'mc-advanceCost'].forEach(idc => { const e = el(idc); e.addEventListener('input', () => { e.value = withCommas(e.value); }); });
    const numOf = idc => Number(String(el(idc).value).replace(/[^\d.]/g, '')) || 0;
    let grossTouched = !!(r && r.gross), commTouched = !!(r && r.commission);
    const recalcComm = () => { if (commTouched) return; const g = numOf('mc-gross'); el('mc-commission').value = g ? withCommas(String(Math.round(g * 0.5))) : ''; };
    el('mc-commission').addEventListener('input', () => { commTouched = true; });
    el('mc-gross').addEventListener('input', () => { grossTouched = true; recalcComm(); });
    el('mc-amount').addEventListener('input', () => {
      if (!grossTouched) { const a = numOf('mc-amount'); el('mc-gross').value = a ? withCommas(String(Math.round(a * 0.1))) : ''; }
      recalcComm();
    });
    el('mc-save').addEventListener('click', async () => {
      const data = { model: el('mc-model').value, agency: el('mc-agency').value, period: el('mc-period').value, year: el('mc-year').value,
        amount: el('mc-amount').value, gross: el('mc-gross').value, commission: el('mc-commission').value, expense: el('mc-expense').value, advanceCost: el('mc-advanceCost').value,
        status: el('mc-status').value, paymentInfo: el('mc-paymentInfo').value, note: el('mc-note').value };
      try {
        if (r) { const x = await api('/api/mac/' + r.id, { method: 'PATCH', body: JSON.stringify(data) }); Object.assign(r, x.mac); }
        else { const x = await api('/api/mac', { method: 'POST', body: JSON.stringify(data) }); macRecords.push(x.mac); }
        closeDrawer(); loadMac();
      } catch (e) { alert('Could not save: ' + (e.message || e)); }
    });
    if (r) el('mc-del').addEventListener('click', async () => {
      if (!confirm('Delete this record?')) return;
      try { await api('/api/mac/' + r.id, { method: 'DELETE' }); } catch (err) { alert('Could not delete: ' + err.message); return; }
      macRecords = macRecords.filter(x => x.id !== r.id); closeDrawer(); renderMac();
    });
    openDrawer();
  }
  function exportMac() {
    const rows = macRowsCache;
    if (!rows.length) { alert('No records to export.'); return; }
    const header = ['#', 'Period', 'Model', 'Agency', 'Model amount', 'Gross MAC 10%', "Wolf's share 5%", 'Expense', 'Advance cost', 'Status', 'Payment info', 'Scouter'];
    const data = rows.map((r, i) => [i + 1, r.period, r.model, r.agency, Math.round(r.amount || 0), Math.round(r.gross || 0), Math.round(r.commission || 0), Math.round(r.expense || 0), Math.round(r.advanceCost || 0), r.status, r.paymentInfo, r.ownerName || r.owner]);
    const e2 = v => { v = String(v == null ? '' : v);
      if (/^[=+\-@]/.test(v)) v = "'" + v;               // neutralise spreadsheet formula injection (=,+,-,@)
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const csv = [header, ...data].map(r => r.map(e2).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'MAC-record-' + todayLocal() + '.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (el('mac-add')) el('mac-add').addEventListener('click', () => openMacForm(null));
  if (el('mac-export')) el('mac-export').addEventListener('click', exportMac);
  if (el('mac-refresh')) el('mac-refresh').addEventListener('click', loadMac);
  ['mac-year', 'mac-owner', 'mac-search'].forEach(idc => { if (el(idc)) el(idc).addEventListener('input', renderMac); });

  /* ============= MODEL DIRECTORY (contacts — no money) ============= */
  let models = [];
  // The agency's model categories — same split as the MODELS CONTACTS sheet.
  const MODEL_CATS = ['MP Models', 'Freelancer', 'Thai Models', 'Plus Size',
    'Talents (Old)', 'MC', 'Kids', 'Direct Models', 'Body Talent', 'Transgender', 'Talents'];
  const MODEL_STATUSES = ['In town', 'Out of town', 'Direct booking', 'Left'];
  let mStatus = '';   // quick availability filter driven by the chips
  let mSelected = new Set();   // bulk-selected model ids (checkboxes)
  let mCat = '';      // active category: '' = show the category tiles, else drill into one
  const canEditModels = () => ['master', 'admin', 'designer'].includes(role);   // booker + scouter view only
  async function loadModels() {
    try { models = (await api('/api/models')).models || []; } catch (_) { models = []; }
    // fill the category filter once
    const cf = el('m-cat');
    if (cf && cf.options.length <= 1) {
      cf.innerHTML = '<option value="">All categories</option>' +
        MODEL_CATS.map(c => `<option>${c}</option>`).join('');
    }
    // Country/nationality suggestions for the type-to-search box (skip junk like
    // phone numbers, "?", stray values that leaked into the column).
    const dl = el('m-country-list');
    if (dl) {
      const countries = [...new Set(models.map(m => (m.country || '').trim())
        .filter(c => c && c.length >= 3 && c !== '?' && !/^[.\+\d\s\-()]+$/.test(c)))]
        .sort((a, b) => a.localeCompare(b));
      dl.innerHTML = countries.map(c => `<option value="${esc(c)}"></option>`).join('');
    }
    renderModels();
  }
  // Find a model's saved contact by the name a booker typed on a booking.
  function modelByName(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    return models.find(m => (m.name || '').trim().toLowerCase() === n)
        || models.find(m => (m.nickname || '').trim().toLowerCase() === n) || null;
  }
  function visaSoon(dstr) {
    if (!isISODate(dstr)) return false;
    const days = Math.round((new Date(dstr + 'T00:00:00Z') - new Date(todayLocal() + 'T00:00:00Z')) / 86400000);
    return days >= 0 && days <= 30;
  }
  // Landing page: category tiles the team clicks into (instead of 158 cards at once).
  function renderCatTiles() {
    el('m-grid').style.display = 'none';
    el('m-backbar').style.display = 'none';
    el('m-status-chips').style.display = 'none';
    el('m-empty').style.display = 'none';
    el('m-cats').style.display = 'grid';
    const tally = {};
    models.forEach(m => { const c = m.category || '__none__'; tally[c] = (tally[c] || 0) + 1; });
    el('m-count').textContent = `${models.length} models — pick a category`;
    let tiles = `<button class="m-cat-tile all" data-cat="__all__"><span class="nm">All models</span><span class="ct">${models.length}</span></button>`;
    MODEL_CATS.forEach(c => { if (tally[c]) tiles += `<button class="m-cat-tile" data-cat="${esc(c)}"><span class="nm">${esc(c)}</span><span class="ct">${tally[c]}</span></button>`; });
    if (tally['__none__']) tiles += `<button class="m-cat-tile" data-cat="__none__"><span class="nm">Uncategorised</span><span class="ct">${tally['__none__']}</span></button>`;
    el('m-cats').innerHTML = tiles;
    el('m-cats').querySelectorAll('.m-cat-tile').forEach(t =>
      t.addEventListener('click', () => { mCat = t.dataset.cat; syncCatDropdown(); renderModels(); }));
  }
  function syncCatDropdown() {
    const sel = el('m-cat');
    if (sel) sel.value = (mCat === '__all__' || mCat === '__none__') ? '' : mCat;
  }
  const sexMatch = (m, want) => {
    const s = (m.sex || '').trim().toLowerCase();
    if (want === 'Female') return s.startsWith('female');
    if (want === 'Male') return s.startsWith('male');
    if (want === 'Transgender') return s.includes('trans') || s.includes('trang');
    return true;
  };
  const sexNorm = (m) => {
    if (!m) return '';
    if (sexMatch(m, 'Female')) return 'Female';
    if (sexMatch(m, 'Male')) return 'Male';
    if (sexMatch(m, 'Transgender')) return 'Transgender';
    return '';
  };
  function renderModels() {
    const term = el('m-search').value.trim().toLowerCase();
    const country = el('m-country').value.trim().toLowerCase();
    const sex = el('m-sex').value;
    // With nothing chosen, show the category tiles; a search/filter drills into all.
    let cat = mCat;
    if (!cat && (term || country || sex || mStatus)) cat = '__all__';
    if (!cat) { renderCatTiles(); return; }
    el('m-cats').style.display = 'none';
    el('m-grid').style.display = '';
    el('m-backbar').style.display = 'flex';
    el('m-status-chips').style.display = 'flex';
    el('m-crumb').textContent = cat === '__all__' ? 'All models' : (cat === '__none__' ? 'Uncategorised' : cat);
    let list = models.filter(m => {
      if (cat === '__none__') { if (m.category) return false; }
      else if (cat !== '__all__' && (m.category || '') !== cat) return false;
      if (sex && !sexMatch(m, sex)) return false;
      if (country && !(m.country || '').toLowerCase().includes(country)) return false;
      if (mStatus && (m.status || '') !== mStatus) return false;
      if (term) return [m.name, m.nickname, m.country, m.phone, m.line, m.email, m.location, m.modelCode, ('mp-' + String(m.modelNo || '').padStart(4, '0')), String(m.modelNo || '')].join(' ').toLowerCase().includes(term);
      return true;
    });
    // Order by real code: newest YEAR first, then category, then running number
    // (001, 002, 003…) — like the master sheet, but current models on top.
    // Anyone without a code yet follows, by name.
    const codeKey = m => {
      if (!m.modelCode) return '1~' + (m.name || '').toLowerCase();
      const mm = /^MP(\d{2})-(\d{2})-(\d+)/.exec(m.modelCode);
      if (!mm) return '0~' + m.modelCode;
      const yInv = String(99 - parseInt(mm[1], 10)).padStart(2, '0');   // year descending
      return '0' + yInv + mm[2] + mm[3].padStart(4, '0');
    };
    list.sort((a, b) => codeKey(a).localeCompare(codeKey(b)));
    // Render a page at a time so huge categories (1,000+) stay fast.
    const CAP = 300;
    const shown = list.slice(0, CAP);
    el('m-count').textContent = list.length > CAP
      ? `Showing first ${CAP} of ${list.length} — type a name or use the filters to narrow`
      : `${list.length} model${list.length === 1 ? '' : 's'}`;
    el('m-empty').style.display = list.length ? 'none' : 'block';
    const chip = (ic, v) => v ? `<span class="m-c"><span class="ic">${ic}</span>${esc(v)}</span>` : '';
    // Group key MUST use the same strict pattern as the sort key — a looser match
    // here made oddly-formatted codes emit a duplicate year header further down.
    const codeYear = c => { const mm = /^MP(\d{2})-(\d{2})-(\d+)/.exec(c || ''); return mm ? '20' + mm[1] : 'other'; };
    const groupOf = m => m.modelCode ? codeYear(m.modelCode) : 'nocode';
    const groupLabel = { other: 'Other codes', nocode: 'No code yet' };
    const rowHtml = m => {
      const contacts = [chip('📱', m.phone), chip('💬', m.whatsapp), chip('🟢', m.line), chip('✉', m.email), chip('📸', m.ig)].filter(Boolean).join('');
      const hasContact = m.phone || m.whatsapp || m.line || m.email || m.ig;
      const stCls = { 'In town': 'st-intown', 'Out of town': 'st-outoftown', 'Direct booking': 'st-direct', 'Left': 'st-left' }[m.status] || '';
      const statusPill = m.status ? `<span class="m-status-pill ${stCls}">${esc(m.status)}</span>` : '';
      const visa = m.visaExpiry ? `<span class="m-c"><span class="ic">🛂</span><span class="${visaSoon(m.visaExpiry) ? 'm-visa-soon' : ''}">${esc(m.visaExpiry)}${visaSoon(m.visaExpiry) ? ' ⚠' : ''}</span></span>` : '';
      const ma = m.motherAgency ? `<span class="m-c" title="${esc(m.motherAgency)}"><span class="ic">🏢</span>${esc(m.motherAgency.split('\n')[0].trim().slice(0, 26))}</span>` : '';
      // Show the REAL model code (from the master sheet / FlowAccount). Fall back to
      // the old running number only if a model has no code yet.
      const idTag = m.modelCode
        ? `<span class="m-no" title="Model code (same as FlowAccount)">${esc(m.modelCode)}</span>`
        : (m.modelNo ? `<span class="m-no m-no-tmp" title="No code from the sheet yet">MP-${String(m.modelNo).padStart(4, '0')}</span>` : '');
      const age = m.age ? `<span class="m-c"><span class="ic">🎂</span>${esc(m.age)}</span>` : '';
      const loc = m.location ? `<span class="m-c"><span class="ic">📍</span>${esc(m.location)}</span>` : '';
      return `<div class="m-row" data-id="${m.id}">
        <div class="m-r-id">
          ${canEditModels() ? `<input type="checkbox" class="m-sel" data-id="${m.id}" ${mSelected.has(m.id) ? 'checked' : ''} title="Select for bulk move">` : ''}
          ${idTag}
          <span class="m-name">${esc(m.name) || '—'}</span>
          ${m.nickname ? `<span class="m-nick">${esc(m.nickname)}</span>` : ''}
          ${m.category ? `<span class="m-badge ${m.category === 'MP Models' ? 'mp' : 'free'}">${esc(m.category)}</span>` : ''}
          ${statusPill}
        </div>
        <div class="m-r-meta">${m.country ? `<span class="m-c"><span class="ic">🌏</span>${esc(m.country)}</span>` : ''}${age}${loc}${ma}${contacts}${visa}${!hasContact ? '<span class="m-missing">✎ no contact yet</span>' : ''}</div>
      </div>`;
    };
    // Build the list with a year heading each time the code's year changes.
    let lastYear = '__init__';
    const html = [];
    shown.forEach(m => {
      const yr = groupOf(m);
      if (yr !== lastYear) {
        lastYear = yr;
        const n = list.filter(x => groupOf(x) === yr).length;
        html.push(`<div class="m-year-div">${groupLabel[yr] || 'MP ' + yr}<span class="m-year-n">${n}</span></div>`);
      }
      html.push(rowHtml(m));
    });
    el('m-grid').innerHTML = html.join('');
    const canDrag = canEditModels();
    if (el('m-drag-hint')) el('m-drag-hint').style.display = canDrag ? 'flex' : 'none';
    renderBulkBar(shown);
    el('m-grid').querySelectorAll('.m-sel').forEach(cb => {
      cb.addEventListener('click', ev => ev.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) mSelected.add(cb.dataset.id); else mSelected.delete(cb.dataset.id);
        renderBulkBar(shown);
      });
    });
    el('m-grid').querySelectorAll('.m-row').forEach(c => {
      c.addEventListener('click', () => openModelEdit(c.dataset.id));
      if (canDrag) {
        c.setAttribute('draggable', 'true');
        c.addEventListener('dragstart', ev => {
          ev.dataTransfer.setData('text/plain', c.dataset.id);
          ev.dataTransfer.effectAllowed = 'move';
          c.classList.add('m-dragging');
        });
        c.addEventListener('dragend', () => c.classList.remove('m-dragging'));
      }
    });
  }
  function modelField(label, id, val, ph) {
    const list = id === 'country' ? 'list="m-country-list"' : '';
    return `<div class="field"><label>${label}</label><input id="md-${id}" ${list} value="${esc(val || '')}" placeholder="${ph || ''}" ${canEditModels() ? '' : 'readonly'}></div>`;
  }
  function openModelEdit(id) {
    const m = id ? models.find(x => x.id === id) : null;
    const edit = canEditModels();
    el('d-title').textContent = m ? (edit ? 'Edit model' : m.name) : 'Add model';
    el('drawer-body').innerHTML = `
      <div class="field"><label>Model Code <span style="color:#999;font-weight:400;text-transform:none;letter-spacing:0">· same code Aim uses in FlowAccount</span></label>
        <input id="md-modelCode" value="${esc((m && m.modelCode) || '')}" placeholder="e.g. MP26-08-001" ${edit ? '' : 'readonly'}></div>
      ${m && !m.modelCode && m.modelNo ? `<p style="margin:-8px 0 12px;color:#b06a1a;font-size:11.5px">No code from the master sheet yet — temporary ref MP-${String(m.modelNo).padStart(4, '0')}</p>` : ''}
      <div class="field two">
        ${modelField('Name', 'name', m && m.name, 'as bookers type it')}
        ${modelField('Nickname', 'nickname', m && m.nickname)}
      </div>
      <div id="md-name-warn" class="dup-warn" style="display:none"></div>
      <div class="field two">${modelField('Age', 'age', m && m.age, 'e.g. 22')}${modelField('Location', 'location', m && m.location, 'e.g. Bangkok / area')}</div>
      <div class="field two">
        <div class="field" style="margin:0"><label>Category</label>
          <select id="md-category" ${edit ? '' : 'disabled'}>
            ${['', ...MODEL_CATS].map(c => `<option ${((m && m.category) || '') === c ? 'selected' : ''}>${c || '—'}</option>`).join('')}
          </select></div>
        <div class="field" style="margin:0"><label>Availability</label>
          <select id="md-status" ${edit ? '' : 'disabled'}>
            ${['', ...MODEL_STATUSES].map(s => `<option ${((m && m.status) || '') === s ? 'selected' : ''}>${s || '—'}</option>`).join('')}
          </select></div>
      </div>
      <div class="field manager-only"><label>Scouter <span style="font-weight:400;color:var(--grey);font-size:11px">· links this model to a scouter's ledger & login</span></label>
        <select id="md-scouter" ${edit ? '' : 'disabled'}>
          <option value="">— none —</option>
          <option value="scouter@mpmodelsbkk.com" ${(m && m.scouter) === 'scouter@mpmodelsbkk.com' ? 'selected' : ''}>Wolf</option>
        </select></div>
      <div class="field two">
        <div class="field" style="margin:0"><label>Sex</label>
          <select id="md-sex" ${edit ? '' : 'disabled'}>
            ${['', 'Female', 'Male', 'Transgender'].map(s => `<option ${sexNorm(m) === s ? 'selected' : ''}>${s || '—'}</option>`).join('')}
          </select></div>
        ${modelField('Country / nationality', 'country', m && m.country)}
      </div>
      <div class="field two">${modelField('Phone', 'phone', m && m.phone)}${modelField('WhatsApp', 'whatsapp', m && m.whatsapp)}</div>
      <div class="field two">${modelField('LINE ID', 'line', m && m.line)}${modelField('Email', 'email', m && m.email)}</div>
      ${modelField('Instagram', 'ig', m && m.ig, '@handle or link')}
      <div class="field two">${modelField('Visa type', 'visaType', m && m.visaType)}${modelField('Visa expiry', 'visaExpiry', m && m.visaExpiry, 'YYYY-MM-DD')}</div>
      <div class="field two">${modelField('Work permit', 'workPermit', m && m.workPermit)}${modelField('Comp card', 'compCard', m && m.compCard)}</div>
      <div class="field"><label>Mother agency (name / contact)</label><textarea id="md-motherAgency" rows="2" ${canEditModels() ? '' : 'readonly'} placeholder="e.g. Supermoda · name · email">${esc(m && m.motherAgency || '')}</textarea></div>
      <div class="field two">${modelField('Arrival', 'arrival', m && m.arrival, 'YYYY-MM-DD')}${modelField('Departure', 'departure', m && m.departure, 'YYYY-MM-DD')}</div>
      <div class="field"><label>Note</label><textarea id="md-note" rows="3" ${edit ? '' : 'readonly'}>${esc(m && m.note || '')}</textarea></div>
      ${edit ? `<div class="drawer-actions">
        <button class="btn" id="md-save">${m ? 'Save' : 'Add model'}</button>
        ${m ? '<button class="link" id="md-del" style="color:var(--declined)">Delete</button>' : ''}
      </div>` : '<p style="color:var(--grey);font-size:12.5px">View only — ask Admin or the designer to edit.</p>'}`;
    if (edit) {
      // Live "already on the list" check as the name is typed.
      const nameEl = el('md-name'), warnEl = el('md-name-warn');
      const checkDup = () => {
        const v = nameEl.value.trim().toLowerCase();
        const clash = v && models.find(x => String(x.name || '').trim().toLowerCase() === v && (!m || x.id !== m.id));
        if (clash) { warnEl.style.display = 'block'; warnEl.textContent = '⚠ “' + nameEl.value.trim() + '” is already on the list — give this one a unique name (add a surname or initial).'; }
        else warnEl.style.display = 'none';
      };
      nameEl.addEventListener('input', checkDup);
      checkDup();

      el('md-save').addEventListener('click', async () => {
        const F = ['name', 'nickname', 'country', 'phone', 'whatsapp', 'line', 'email', 'ig', 'visaType', 'visaExpiry', 'workPermit', 'compCard', 'arrival', 'departure', 'note', 'motherAgency', 'age', 'location', 'modelCode', 'scouter'];
        const cat = el('md-category').value === '—' ? '' : el('md-category').value;
        const data = { category: cat, agency: cat === 'MP Models' ? 'MP' : (cat ? 'Freelance' : ''), status: el('md-status').value === '—' ? '' : el('md-status').value, sex: el('md-sex').value === '—' ? '' : el('md-sex').value };
        F.forEach(k => data[k] = el('md-' + k).value);
        if (!data.name.trim()) { alert('Please enter a name.'); return; }
        const btn = el('md-save'); btn.disabled = true; btn.textContent = 'Saving…';
        try {
          if (m) { const r = await api('/api/models/' + m.id, { method: 'PATCH', body: JSON.stringify(data) }); Object.assign(m, r.model); }
          else {
            const r = await api('/api/models', { method: 'POST', body: JSON.stringify(data) });
            models.push(r.model);
          }
          renderModels(); closeDrawer();
        } catch (err) {
          btn.disabled = false; btn.textContent = m ? 'Save' : 'Add model';
          if (err && err.body && err.body.duplicate) {   // server rejected a same-name model
            warnEl.style.display = 'block';
            warnEl.textContent = '⚠ ' + (err.message || 'That model is already on the list.');
          } else if (err && err.message !== 'unauthorized') {
            alert('Could not save: ' + (err.message || 'please try again.'));
          }
        }
      });
      if (m) el('md-del').addEventListener('click', async () => {
        if (!confirm('Delete ' + m.name + ' from the directory?')) return;
        try {
          await api('/api/models/' + m.id, { method: 'DELETE' });
          models = models.filter(x => x.id !== m.id);
          renderModels(); closeDrawer();
        } catch (err) { if (err.message !== 'unauthorized') alert('Could not delete: ' + err.message); }
      });
    }
    openDrawer();
  }
  el('m-add').addEventListener('click', () => openModelEdit(null));
  el('m-refresh').addEventListener('click', loadModels);
  // One-time: import real model codes from the master sheet (managers only).
  ['m-search', 'm-country', 'm-sex'].forEach(idc => el(idc).addEventListener('input', renderModels));
  el('m-cat').addEventListener('change', () => { mCat = el('m-cat').value; renderModels(); });
  el('m-back').addEventListener('click', () => {
    mCat = ''; mStatus = '';
    el('m-search').value = ''; el('m-country').value = ''; el('m-cat').value = ''; el('m-sex').value = '';
    el('m-status-chips').querySelectorAll('.m-chip').forEach(x => x.classList.remove('active'));
    el('m-status-chips').querySelector('[data-st=""]').classList.add('active');
    renderModels();
  });
  // ---- Bulk actions bar (Ploy: tick many → move status / change category at once) ----
  function renderBulkBar(shown) {
    const bar = el('m-bulkbar'); if (!bar) return;
    if (!canEditModels() || !mSelected.size) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = 'flex';
    bar.innerHTML = `<b>${mSelected.size} selected</b>
      <select id="mb-status"><option value="">Move to status…</option>${MODEL_STATUSES.map(st => `<option>${st}</option>`).join('')}<option value="__clear__">(clear status)</option></select>
      <select id="mb-cat"><option value="">Set category…</option>${MODEL_CATS.map(c => `<option>${esc(c)}</option>`).join('')}</select>
      <button class="link" id="mb-all">Select all shown</button>
      <button class="link" id="mb-clear">Clear selection</button>`;
    el('mb-status').addEventListener('change', () => {
      const v = el('mb-status').value; if (!v) return;
      applyBulk({ status: v === '__clear__' ? '' : v });
    });
    el('mb-cat').addEventListener('change', () => {
      const v = el('mb-cat').value; if (!v) return;
      applyBulk({ category: v });
    });
    el('mb-all').addEventListener('click', () => {
      (shown || []).forEach(m => mSelected.add(m.id));
      renderModels();
    });
    el('mb-clear').addEventListener('click', () => { mSelected.clear(); renderModels(); });
  }
  async function applyBulk(set) {
    const ids = [...mSelected];
    const what = set.status !== undefined ? (`status → ${set.status || 'cleared'}`) : (`category → ${set.category}`);
    if (!confirm(`Apply to ${ids.length} model${ids.length > 1 ? 's' : ''}?\n\n${what}`)) { renderModels(); return; }
    try {
      const r = await api('/api/models', { method: 'POST', body: JSON.stringify({ __bulk: true, ids, set }) });
      models.forEach(m => {
        if (!mSelected.has(m.id)) return;
        if (set.status !== undefined) m.status = set.status;
        if (set.category !== undefined) { m.category = set.category; m.agency = set.category === 'MP Models' ? 'MP' : (set.category ? 'Freelance' : ''); }
      });
      mSelected.clear();
      renderModels();
      toast(`✓ Updated ${r.updated} models`);
    } catch (err) { if (err.message !== 'unauthorized') alert('Bulk update failed: ' + err.message); }
  }

  el('m-status-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.m-chip'); if (!b) return;
    el('m-status-chips').querySelectorAll('.m-chip').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    mStatus = b.dataset.st;
    renderModels();
  });
  // Drag a model row onto a status chip to move it there — bulk cleanup without opening each.
  el('m-status-chips').querySelectorAll('.m-chip').forEach(chip => {
    if (!chip.dataset.st) return;                      // "All" is not a drop target
    chip.addEventListener('dragover', ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; chip.classList.add('drop-hot'); });
    chip.addEventListener('dragleave', () => chip.classList.remove('drop-hot'));
    chip.addEventListener('drop', async ev => {
      ev.preventDefault(); chip.classList.remove('drop-hot');
      if (!canEditModels()) return;
      const id = ev.dataTransfer.getData('text/plain'); if (!id) return;
      // Dragging a TICKED row moves the whole selection at once.
      if (mSelected.has(id) && mSelected.size > 1) { applyBulk({ status: chip.dataset.st }); return; }
      const m = models.find(x => x.id === id); if (!m) return;
      const st = chip.dataset.st;
      if ((m.status || '') === st) return;
      const prev = m.status; m.status = st;             // optimistic — row leaves the current filter
      renderModels();
      try { const r = await api('/api/models/' + id, { method: 'PATCH', body: JSON.stringify({ status: st }) }); Object.assign(m, r.model); }
      catch (_) { m.status = prev; renderModels(); alert('Could not move that model — please try again.'); }
    });
  });

  /* ============= 7b. ACTIVITY LOG (Director / Admin) ============= */
  let activity = [];
  async function loadActivity() {
    try {
      const data = await api('/api/activity');
      activity = data.activity || [];
      // populate the user filter
      const users = distinct(activity.map(a => a.name || a.email)).sort();
      const cur = el('a-user').value;
      el('a-user').innerHTML = '<option value="">All users</option>' +
        users.map(u => `<option value="${esc(u)}" ${u === cur ? 'selected' : ''}>${esc(u)}</option>`).join('');
      renderActivity();
    } catch (_) { /* bookers get 403 — tab is hidden for them anyway */ }
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function renderActivity() {
    const who = el('a-user').value;
    const type = el('a-type').value;   // changes | schedule | jobs | logins | all
    const term = el('a-search').value.trim().toLowerCase();
    const list = activity.filter(a => {
      if (who && (a.name || a.email) !== who) return false;
      const act = a.action || '';
      if (type === 'changes' && act === 'login') return false;
      if (type === 'schedule' && !act.includes('schedule')) return false;
      if (type === 'jobs' && !act.includes('job')) return false;
      if (type === 'logins' && act !== 'login') return false;
      if (term && !`${a.action} ${a.detail}`.toLowerCase().includes(term)) return false;
      return true;
    });
    el('a-empty').style.display = list.length ? 'none' : 'block';
    el('a-rows').innerHTML = list.map(a => `
      <tr>
        <td style="white-space:nowrap">${fmtTime(a.time)}</td>
        <td>${esc(a.name || a.email)}</td>
        <td>${esc(a.role === 'master' ? 'Director' : a.role === 'admin' ? 'Admin' : a.role === 'designer' ? 'Graphic' : a.role === 'scouter' ? 'Scouter' : a.role === 'system' ? 'System' : 'Booker')}</td>
        <td>${esc(a.action)}</td>
        <td>${esc(a.detail) || '—'}</td>
      </tr>`).join('');
  }
  ['a-type', 'a-user', 'a-search'].forEach(idc => el(idc).addEventListener('input', renderActivity));
  el('a-refresh').addEventListener('click', loadActivity);

  /* ================= 8. BOOT ================= */
  function start() {
    calMonth = todayLocal().slice(0, 7); showApp(); loadAll().catch(() => {});
    // Scouter's home is the Mother-Agency ledger (Job Tracker is hidden for them).
    if (role === 'scouter') { const t = document.querySelector('.tab[data-view="mac"]'); if (t) t.click(); }
  }
  if (token) api('/api/jobs').then(() => start()).catch(() => showLogin());
  else showLogin();
})();
