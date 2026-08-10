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
    'workPackage', 'breakHours', 'overtimeRate', 'overtimeFee', 'paymentTerm', 'remark',
  ];

  // Standard on-set hours for each work package (break is added on top).
  const PACKAGES = {
    photo4:  { label: 'Photoshoot – 4 hours',        hours: 4,  brk: 0 },
    photo8:  { label: 'Photoshoot – 8 hours',        hours: 8,  brk: 0 },
    video12: { label: 'Video – 12 hours (1h break)', hours: 12, brk: 1 },
  };
  const isISODate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

  let token = sessionStorage.getItem(STORE_KEY) || '';
  let role  = sessionStorage.getItem('mp_admin_role') || '';
  let jobs = [];
  let schedule = [];

  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Only master/admin see money (budgets, prices, revenue). Bookers do not.
  const canSeeMoney = () => role === 'master' || role === 'admin';
  function applyRole() {
    document.body.classList.toggle('role-booker', role === 'booker');
    // Graphic designer: browses jobs/schedule to source photos & videos, sees NO money at all.
    document.body.classList.toggle('role-designer', role === 'designer');
    const who = el('whoami');
    if (who) {
      const name = sessionStorage.getItem('mp_admin_name') || '';
      const roleLabel = role === 'master' ? 'Director' : role === 'admin' ? 'Admin'
        : role === 'designer' ? 'Graphic Designer' : 'Booker';
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
    return res.json();
  }

  /* ================= 2. LOAD DATA ================= */
  // Order-independent fingerprint of a list, so we only re-render on a REAL change
  // (not because the server returned the same items in a different order).
  const fingerprint = arr => (arr || []).map(x => JSON.stringify(x)).sort().join('|');
  async function loadAll() {
    const [a, b] = await Promise.all([api('/api/jobs'), api('/api/schedule')]);
    jobs = a.jobs || [];
    schedule = b.schedule || [];
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
  async function checkVersion() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const v = (await r.json()).version;
      if (!v) return;
      if (loadedVersion === null) { loadedVersion = v; return; }   // first read = our version
      if (v === loadedVersion) return;                             // unchanged — do nothing
      // New version live. Only a hidden (background) tab reloads itself, and only if we
      // haven't just reloaded (prevents any reload loop). A visible tab just shows the bar.
      let last = 0; try { last = +(sessionStorage.getItem('mp_reload_at') || 0); } catch (_) {}
      const now = new Date().getTime();
      if (document.hidden && now - last > 180000) {
        try { sessionStorage.setItem('mp_reload_at', String(now)); } catch (_) {}
        location.reload();
      } else {
        showUpdateBar();
      }
    } catch (_) { /* offline — try again next tick */ }
  }
  setInterval(checkVersion, 60000);
  checkVersion();   // establish/confirm version right away

  /* ================= 3. HELPERS ================= */
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function monthLabel(m) {                 // '2026-08' -> 'Aug 2026'
    const [y, mm] = (m || '').split('-');
    return mm ? `${MONTH_NAMES[+mm - 1]} ${y}` : m;
  }
  const CUR_SYM = { THB: '฿', USD: '$', CNY: '¥' };
  function money(n, cur) { return (CUR_SYM[cur] || '฿') + Math.round(Number(n || 0)).toLocaleString('en-US'); }
  const withCommas = v => { const r = String(v || '').replace(/[^\d]/g, ''); return r ? Number(r).toLocaleString('en-US') : ''; };
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
  // Sort so job codes run DOWN in sequence — booking order (that's when a code is
  // assigned), so each column's numbers climb (…B1110, B1111, B1112…), like the sheet.
  const jobCodeNum = j => { const m = String(j.jobId || j.jobIdNonTax || '').match(/\d{3,6}/); return m ? +m[0] : 0; };
  function sortedJobs() {
    return filteredJobs().slice().sort((a, b) => {
      const ba = /^\d{4}-\d{2}-\d{2}$/.test(a.bookingDate || '') ? a.bookingDate : '9999-99-99';
      const bb = /^\d{4}-\d{2}-\d{2}$/.test(b.bookingDate || '') ? b.bookingDate : '9999-99-99';
      return ba.localeCompare(bb) || jobCodeNum(a) - jobCodeNum(b);
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

    // Aggregate revenue by invoice type → bank account (THB accounts). Foreign
    // currencies (USD, CNY) are never mixed with THB — each gets its own total.
    const curOf = j => j.currency || 'THB';
    const thb = list.filter(j => curOf(j) === 'THB');
    const totalBudget = thb.reduce((s, j) => s + Number(j.budget || 0), 0);
    const taxBudget = thb.filter(j => !isNonTax(j)).reduce((s, j) => s + Number(j.budget || 0), 0);
    const nonTaxBudget = totalBudget - taxBudget;
    const foreignTiles = ['USD', 'CNY'].map(c => {
      const rows = list.filter(j => curOf(j) === c);
      if (!rows.length) return '';
      const sum = rows.reduce((s, j) => s + Number(j.budget || 0), 0);
      return `<div class="stat money revenue-only"><div class="n">${money(sum, c)}</div><div class="l">${c} total</div></div>`;
    }).join('');

    // Each booker sees their OWN sales total (THB) — not the company-wide totals.
    let mySalesTile = '';
    if (role === 'booker') {
      const mine = sessionStorage.getItem('mp_admin_bookername') || '';
      if (mine) {
        const mySum = thb.filter(j => (j.booker || '').toLowerCase() === mine.toLowerCase())
          .reduce((s, j) => s + Number(j.budget || 0), 0);
        mySalesTile = `<div class="stat money"><div class="n">${money(mySum)}</div><div class="l">My sales · ${esc(mine)}</div></div>`;
      }
    }

    el('j-stats').innerHTML = `
      <div class="stat"><div class="n">${list.length}</div><div class="l">Jobs</div></div>
      <div class="stat"><div class="n">${castings}</div><div class="l">Castings (leads)</div></div>
      <div class="stat"><div class="n">${options}</div><div class="l">Options (leads)</div></div>
      ${mySalesTile}
      <div class="stat money"><div class="n">${money(totalBudget)}</div><div class="l">Team total (THB)</div></div>
      <div class="stat money revenue-only"><div class="n">${money(taxBudget)}</div><div class="l">Tax invoice · KBank</div></div>
      <div class="stat money nontax revenue-only"><div class="n">${money(nonTaxBudget)}</div><div class="l">Non-Tax · SCB</div></div>
      ${foreignTiles}`;

    el('j-empty').style.display = list.length ? 'none' : 'block';
    el('j-rows').innerHTML = list.map(j => {
      // Split the code into its own column: C-code = Tax, B-code = Non-Tax.
      const taxCode = /b\s?\d/i.test(j.jobId || '') ? '' : (j.jobId || '');   // C (or blank)
      const nonTaxCode = j.jobIdNonTax || (/b\s?\d/i.test(j.jobId || '') ? j.jobId : '');   // B
      const who = [j.model, j.freelance].filter(Boolean).map(esc).join(' / ') || '—';
      const webBadge = j.source === 'website' ? ' <span class="badge web">web</span>' : '';
      return `
      <tr class="row ${j.source === 'website' ? 'web' : ''}" data-id="${j.id}">
        <td>${esc(j.jobDate) || '—'}</td>
        <td class="code-c">${esc(taxCode) || '<span class="code-dash">—</span>'}</td>
        <td class="code-b">${esc(nonTaxCode) || '<span class="code-dash">—</span>'}</td>
        <td class="title-cell">${esc(j.jobTitle) || '—'}${webBadge}${matBadge(j.materials)}${j.internalNote ? ' <span class="note-dot" title="Has an internal note">📝</span>' : ''}</td>
        <td>${who}</td>
        <td>${esc(j.client) || '—'}</td>
        <td>${esc(j.booker) || '—'}</td>
        <td class="num money">${j.budget ? money(j.budget, j.currency) : '—'}</td>
      </tr>`;
    }).join('');

    el('j-rows').querySelectorAll('tr.row').forEach(tr =>
      tr.addEventListener('click', () => openJob(tr.dataset.id)));
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
  el('j-add').addEventListener('click', () => openJob(null));

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
      <div style="margin:-8px 0 16px;display:flex;gap:16px;font-size:12px">
        <button type="button" class="link" id="gen-tax" style="color:var(--teal)">+ Generate C code (taxed)</button>
        <button type="button" class="link" id="gen-nontax" style="color:var(--web)">+ Generate B code (non-tax)</button>
      </div>
      <div class="field two">
        ${f('Booking Date', 'bookingDate', j?.bookingDate || '')}
        ${f('Job Date', 'jobDate', j?.jobDate || '')}
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
      <div class="field two money">
        <div class="field" style="margin:0"><label>Budget</label>
          <input id="d-budget" type="text" inputmode="numeric" value="${j?.budget ? withCommas(j.budget) : ''}"></div>
        <div class="field" style="margin:0"><label>Currency</label>
          <select id="d-currency">
            <option value="THB" ${(j?.currency || 'THB') === 'THB' ? 'selected' : ''}>THB ฿</option>
            <option value="USD" ${j?.currency === 'USD' ? 'selected' : ''}>USD $</option>
            <option value="CNY" ${j?.currency === 'CNY' ? 'selected' : ''}>CNY ¥</option>
          </select></div>
      </div>
      <div class="field money" style="max-width:220px"><label>Shoot days (fee is often per day)</label>
        <input id="d-shootdays" type="number" min="1" max="10" step="1" value="${j?.shootDays || ''}" placeholder="e.g. 1 or 2"></div>
      ${j && (j.email || j.phone) ? `<div class="field"><label>Contact</label><input value="${esc([j.email, j.phone].filter(Boolean).join('  ·  '))}" readonly></div>` : ''}
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
        ${fld('Break (hours)', `<input id="d-breakHours" type="number" step="0.5" min="0" value="${val('breakHours')}">`)}
      </div>
      <div class="field two">
        <div class="field" style="margin:0"><label>Overtime Rate (THB / hour)</label>
          <input id="d-overtimeRate" type="number" min="0" value="${val('overtimeRate')}"></div>
        ${fld('No. of Shoot', `<input id="d-noOfShoot" value="${val('noOfShoot')}">`)}
      </div>
      <div class="ot-box" id="ot-summary">Choose a work package and enter times to calculate overtime.</div>
      <div class="field two">
        <div class="field" style="margin:0"><label>Overtime Fee (THB)</label>
          <input id="d-overtimeFee" type="number" min="0" value="${val('overtimeFee')}"></div>
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
    const pkg = PACKAGES[el('d-workPackage').value];
    const t1 = el('d-timeStart').value, t2 = el('d-timeEnd').value;
    if (!pkg) { box.textContent = 'Choose a work package to calculate overtime.'; box.className = 'ot-box'; return; }
    if (!t1 || !t2) { box.textContent = `${pkg.label}: enter start & end time to calculate overtime.`; box.className = 'ot-box'; return; }

    let elapsed = (toMinutes(t2) - toMinutes(t1)) / 60;
    if (elapsed < 0) elapsed += 24;                 // shoot ran past midnight
    const brk = parseFloat(el('d-breakHours').value) || 0;
    const allowed = pkg.hours + brk;
    const otHours = billOvertime(elapsed - allowed);
    const rate = parseFloat(el('d-overtimeRate').value) || 0;
    const fee = otHours * rate;

    if (otHours > 0 && rate > 0) el('d-overtimeFee').value = fee;
    else if (otHours === 0) el('d-overtimeFee').value = '';

    box.className = 'ot-box' + (otHours > 0 ? ' has-ot' : '');
    box.innerHTML = `On set <b>${elapsed.toFixed(1)}h</b> · allowed <b>${allowed}h</b> `
      + `(package ${pkg.hours}h + break ${brk}h) → overtime <b>${otHours}h</b>`
      + (rate > 0 ? ` × ฿${rate.toLocaleString()} = <b>฿${fee.toLocaleString()}</b>`
                  : (otHours > 0 ? ' — enter an overtime rate' : ''));
  }

  function wireOvertimeCalc() {
    const pkgEl = el('d-workPackage');
    if (!pkgEl) return;
    pkgEl.addEventListener('change', () => {
      const p = PACKAGES[pkgEl.value];
      // set the default break for this package if the field is empty
      if (p && !el('d-breakHours').value) el('d-breakHours').value = p.brk;
      recalcOvertime();
    });
    ['d-timeStart', 'd-timeEnd', 'd-breakHours', 'd-overtimeRate'].forEach(id =>
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
      notes: el('d-notes').value,
      internalNote: el('d-internalNote') ? el('d-internalNote').value : '',
      materials: el('d-materials') ? el('d-materials').value : '',
      materialsNote: el('d-materialsNote') ? el('d-materialsNote').value : '',
    };
    CLIENT_KEYS.forEach(k => { const e = el('d-' + k); if (e) data[k] = e.value; });
    return data;
  }

  // openJob(id)            → edit an existing job
  // openJob(null)          → blank Add-job form
  // openJob(null, prefill) → Add-job form pre-filled from a casting (see jobPrefillFromEntry)
  function openJob(id, prefill) {
    const j = id ? jobs.find(x => x.id === id) : null;
    const src = j || prefill || null;   // values shown in the form
    el('d-title').textContent = j ? (j.jobTitle || 'Job') : (prefill ? 'New job from casting' : 'Add job');
    const confirmUi = j ? `
        <select id="d-form-type" title="Confirmation form">
          ${MPConfirmation.types.map(t => `<option value="${t.key}" ${t.key === MPConfirmation.defaultType(j) ? 'selected' : ''}>${t.label}</option>`).join('')}
        </select>
        <button class="btn ghost" id="d-confirm-doc">Confirmation</button>` : '';

    el('drawer-body').innerHTML = (prefill ? '<p style="margin:0 0 14px;color:var(--teal);font-size:12.5px">Pre-filled from the casting — add budget & client, then Create.</p>' : '')
      + jobForm(src) + `
      <div class="drawer-actions">
        <button class="btn" id="d-save">${j ? 'Save changes' : 'Create job'}</button>
        ${confirmUi}
        ${j ? '<button class="link" id="d-delete" style="color:var(--declined)">Delete</button>' : ''}
      </div>`;

    wireOvertimeCalc();   // live overtime calculator in the Schedule & fee block

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
      el('d-jobId').value = (await api('/api/next-code')).tax;
    });
    el('gen-nontax').addEventListener('click', async () => {
      el('d-jobIdNonTax').value = (await api('/api/next-code')).nonTax;
    });
    // Printable confirmation form (uses whatever is currently in the form)
    if (j) el('d-confirm-doc').addEventListener('click', () =>
      MPConfirmation.open({ ...j, ...collectJob() }, el('d-form-type').value));

    el('d-save').addEventListener('click', async () => {
      const data = collectJob();
      if (!data.jobTitle.trim()) { alert('Please add a job title.'); return; }
      if (j) {
        const r = await api('/api/jobs/' + j.id, { method: 'PATCH', body: JSON.stringify(data) });
        Object.assign(j, r.job);
      } else {
        const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify(data) });
        jobs.unshift(r.job);
        // If this job came from a casting, mark that casting so it can't be duplicated.
        if (prefill && prefill._fromScheduleId) {
          await api('/api/schedule/' + prefill._fromScheduleId, { method: 'PATCH', body: JSON.stringify({ jobCreated: true }) });
          const e = schedule.find(x => x.id === prefill._fromScheduleId);
          if (e) e.jobCreated = true;
          renderSchedule();
        }
      }
      buildFilters(); renderJobs(); closeDrawer();
    });
    if (j) el('d-delete').addEventListener('click', async () => {
      if (!confirm('Delete this job permanently?')) return;
      await api('/api/jobs/' + j.id, { method: 'DELETE' });
      jobs = jobs.filter(x => x.id !== j.id);
      renderJobs(); closeDrawer();
    });

    openDrawer();
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
        const hay = [e.models, e.casting, e.fitting, e.option, e.job, e.booker].join(' ').toLowerCase();
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
    const typeLabel = e => e.job ? 'Job' : e.fitting ? 'Fitting' : e.shortlist ? 'Shortlist'
      : e.option ? 'Option' : e.casting ? 'Casting' : e.priority ? 'Priority' : 'Entry';
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
        await api('/api/schedule/' + e.id, { method: 'PATCH', body: JSON.stringify({ status: 'open', stage: '' }) });
        e.status = 'open'; e.stage = '';
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
    if (STAGE_KEYS.includes(e.stage)) return e.stage;
    if (e.jobCreated || e.job) return 'shooting';
    if (e.shortlist) return 'shortlist';
    if (e.fitting) return 'fitting';
    if (e.priority) return 'priority';
    if (e.casting && isGoSee(e.casting)) return 'goandsee';   // "Go & See" is its own column
    if (e.option) return 'option';
    if (e.casting) return 'casting';
    return 'casting';
  }
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
    return `<div class="bcard" draggable="true" data-key="${esc(c.key)}" style="border-left-color:${stageColor(c.stage)}">
      <div class="b-subj">${esc(subj)}</div>
      ${e.models ? `<div class="b-models">${esc(e.models)}</div>` : ''}
      ${pp}
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
      const count = (es, k) => new Set(es.filter(e => e[k]).map(e => e.holdGroup || e.id)).size;
      const totalOf = es => new Set(es.map(e => e.holdGroup || e.id)).size;
      let cT = 0, fT = 0, oT = 0, jT = 0, sT = 0, pT = 0, tT = 0;
      const rows = bookers.map(b => {
        const es = entries.filter(e => (e.booker || '(untagged)') === b);
        const c = count(es, 'casting'), f = count(es, 'fitting'), o = count(es, 'option'), j = count(es, 'job'),
          s = count(es, 'shortlist'), p = count(es, 'priority');
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
    if (e.priority) return 'prio';
    if (e.shortlist) return 'short';
    if (e.job) return 'job';
    if (e.fitting) return 'fit';
    if (e.option) return 'opt';
    if (e.casting) return 'cast';
    return 'note';
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
      const time = e.timeStart + (e.timeEnd ? '–' + e.timeEnd : '');
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
        const hay = [e.models, e.casting, e.fitting, e.option, e.job, e.booker].join(' ').toLowerCase();
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
      // Order within a day so the important work shows first (and never gets buried
      // in "+N more"): Work → Shortlist → Casting → Fitting → Options → Priority → Note.
      // Declined/expired entries always sink to the very bottom.
      const CAL_RANK = { job: 0, short: 1, cast: 2, fit: 3, opt: 4, prio: 5, note: 6 };
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

    el('s-calendar').innerHTML = `
      <div class="cal-nav">
        <button class="link cal-prev" title="Previous month">‹</button>
        <p class="cal-title">${monthLabel(month)}</p>
        <button class="link cal-next" title="Next month">›</button>
        <button class="link cal-today" title="Jump to this month">Today</button>
      </div>
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
    el('s-calendar').querySelectorAll('.cal-cell[data-date]').forEach(c =>
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
  function typeDetailsSection(entry) {
    const active = entry ? SCHED_CATS.filter(([k]) => entry[k]).map(([k]) => k) : [];
    // details = the tagged types' text (usually one), else the plain note
    const details = entry
      ? (active.map(k => entry[k]).filter(Boolean).join('\n') || entry.note || '')
      : '';
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
    document.querySelectorAll('.cat-btn').forEach(b =>
      b.addEventListener('click', () => {
        b.classList.toggle('active');
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
    if (active.length) { active.forEach(k => out[k] = details); out.note = ''; }
    else { out.note = details; }
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
          const type = e.priority ? 'Priority' : e.shortlist ? 'Shortlist' : e.job ? 'Job'
            : e.fitting ? 'Fitting' : e.option ? 'Option' : e.casting ? 'Casting' : 'Entry';
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
    for (const [brush, field, , forcedStage] of STAGE_BRUSHES) {
      const days = [...stageDays[brush]].sort();
      if (!days.length) continue;
      const hold = brush === 'option' && days.length > 1;
      const hg = hold ? (crypto.randomUUID ? crypto.randomUUID() : 'h' + Date.now()) : '';
      for (const dt of days) {
        const data = { ...base, date: dt, [field]: details || base.subject || '' };
        if (forcedStage) data.stage = forcedStage;   // e.g. Go & See → its own board column
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
      .replace(/https?:\/\/(?:www\.)?booking\.mpmodelsbkk\.com\S*/gi, '')
      .replace(/https?:\/\/\S*\.up\.railway\.app\S*/gi, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function buildNotifyMessage(e) {
    const typeLabel = e.priority ? 'Admin task' : e.shortlist ? 'Shortlist (hold)'
      : e.job ? 'Job' : e.fitting ? 'Fitting' : e.option ? 'Option' : e.casting ? 'Casting' : 'Schedule';
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
        <div class="drawer-actions"><button class="btn" id="d-add-day">Add entry</button></div>`;
      el('drawer-body').innerHTML = addForm
        + `<hr style="border:none;border-top:1px solid var(--line);margin:18px 0 10px">`
        + `<div style="font-weight:700;font-size:13px;color:var(--grey);margin-bottom:8px">Already on ${esc(dateStr)}</div>`
        + listHtml;
      wireTypeButtons();
      pickedDates = new Set([dateStr]);          // the day they clicked starts selected
      pickerMonth = dateStr.slice(0, 7);
      renderDatePicker();
      const getAddDates = () => pickedList();
      setupConflictCheck(getAddDates, null);
      el('d-add-day').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn.disabled) return;                 // guard: ignore rapid repeat taps
        const dates = getAddDates();
        if (!dates.length) { alert('Click at least one day to hold.'); return; }
        const base = { models: el('d-models').value, subject: schedSubject(), booker: schedBooker(), status: schedStatus(), timeStart: schedTimeStart(), timeEnd: schedTimeEnd(), shootDays: schedShootDays(), ...collectTypeDetails() };
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
    const typeLabel = e.job ? 'Job' : e.fitting ? 'Fitting' : e.shortlist ? 'Shortlist'
      : e.option ? 'Option' : e.casting ? 'Casting' : e.priority ? 'Priority' : 'Entry';
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
      const SKIP = { id: 1, date: 1, month: 1, holdGroup: 1, holdStart: 1, holdEnd: 1, notified: 1, jobCreated: 1 };
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
    const done = () => { buildFilters(); renderSchedule(); if (afterSave) afterSave(); else closeDrawer(); };
    el('d-title').textContent = 'Edit schedule entry';
    el('drawer-body').innerHTML = `
      <div class="field"><label>Date</label><input id="d-date" type="date" value="${esc(e.date)}"></div>
      <div class="field"><label>Models</label><input id="d-models" value="${esc(e.models)}"></div>
      <div id="d-conflict" class="conflict-box" style="display:none"></div>
      ${subjectScheduleField(e)}
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
    // Reveal the "postpone to" date only when Postponed is chosen.
    const statusEl = el('d-sstatus');
    if (statusEl) statusEl.addEventListener('change', () => {
      const w = el('d-postpone-wrap'); if (w) w.style.display = statusEl.value === 'postponed' ? 'block' : 'none';
    });
    const getEditDates = () => [el('d-date').value];
    setupConflictCheck(getEditDates, id);
    el('d-save').addEventListener('click', async () => {
      if (!passesConflictGuard(getEditDates, id)) return;
      const data = { date: el('d-date').value, models: el('d-models').value, subject: schedSubject(), booker: schedBooker(), status: schedStatus(), timeStart: schedTimeStart(), timeEnd: schedTimeEnd(), shootDays: schedShootDays(), ...collectTypeDetails() };
      data.postponeDate = (data.status === 'postponed' && el('d-postponeDate')) ? el('d-postponeDate').value : '';
      if (data.status === 'confirmed') data.stage = 'shooting';   // auto-pilot: confirmed → Confirmed/Shooting box
      const r = await api('/api/schedule/' + id, { method: 'PATCH', body: JSON.stringify(data) });
      Object.assign(e, r.entry);
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
    calMonth = (v === 'all')
      ? (distinct(schedule.map(s => s.month)).sort().reverse()[0] || todayLocal().slice(0, 7))
      : v;
    renderSchedule();
  });
  el('s-refresh').addEventListener('click', loadAll);
  el('s-add').addEventListener('click', openAddSchedule);
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
      };
      if (!(base.models || details || base.subject)) { alert('Add a model or some details first.'); return; }
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
      if (v === 'activity') loadActivity();
      if (v === 'models') loadModels();
    }));

  /* ============= MODEL DIRECTORY (contacts — no money) ============= */
  let models = [];
  // The agency's model categories — same split as the MODELS CONTACTS sheet.
  const MODEL_CATS = ['MP Models', 'Freelancer', 'Thai Models', 'Plus Size',
    'Talents (Old)', 'MC', 'Kids', 'Direct Models', 'Body Talent', 'Transgender', 'Talents'];
  const MODEL_STATUSES = ['In town', 'Out of town', 'Direct booking', 'Left'];
  let mStatus = '';   // quick availability filter driven by the chips
  let mCat = '';      // active category: '' = show the category tiles, else drill into one
  const canEditModels = () => role !== 'booker';   // master/admin/designer edit; booker views
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
      if (term) return [m.name, m.nickname, m.country, m.phone, m.line, m.email].join(' ').toLowerCase().includes(term);
      return true;
    });
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    // Render a page at a time so huge categories (1,000+) stay fast.
    const CAP = 300;
    const shown = list.slice(0, CAP);
    el('m-count').textContent = list.length > CAP
      ? `Showing first ${CAP} of ${list.length} — type a name or use the filters to narrow`
      : `${list.length} model${list.length === 1 ? '' : 's'}`;
    el('m-empty').style.display = list.length ? 'none' : 'block';
    const chip = (ic, v) => v ? `<span class="m-c"><span class="ic">${ic}</span>${esc(v)}</span>` : '';
    el('m-grid').innerHTML = shown.map(m => {
      const contacts = [chip('📱', m.phone), chip('💬', m.whatsapp), chip('🟢', m.line), chip('✉', m.email), chip('📸', m.ig)].filter(Boolean).join('');
      const hasContact = m.phone || m.whatsapp || m.line || m.email || m.ig;
      const stCls = { 'In town': 'st-intown', 'Out of town': 'st-outoftown', 'Direct booking': 'st-direct', 'Left': 'st-left' }[m.status] || '';
      const statusPill = m.status ? `<span class="m-status-pill ${stCls}">${esc(m.status)}</span>` : '';
      const visa = m.visaExpiry ? `<span class="m-c"><span class="ic">🛂</span><span class="${visaSoon(m.visaExpiry) ? 'm-visa-soon' : ''}">${esc(m.visaExpiry)}${visaSoon(m.visaExpiry) ? ' ⚠' : ''}</span></span>` : '';
      const ma = m.motherAgency ? `<span class="m-c" title="${esc(m.motherAgency)}"><span class="ic">🏢</span>${esc(m.motherAgency.split('\n')[0].trim().slice(0, 26))}</span>` : '';
      return `<div class="m-row" data-id="${m.id}">
        <div class="m-r-id">
          <span class="m-name">${esc(m.name) || '—'}</span>
          ${m.nickname ? `<span class="m-nick">${esc(m.nickname)}</span>` : ''}
          ${m.category ? `<span class="m-badge ${m.category === 'MP Models' ? 'mp' : 'free'}">${esc(m.category)}</span>` : ''}
          ${statusPill}
        </div>
        <div class="m-r-meta">${m.country ? `<span class="m-c"><span class="ic">🌏</span>${esc(m.country)}</span>` : ''}${ma}${contacts}${visa}${!hasContact ? '<span class="m-missing">✎ no contact yet</span>' : ''}</div>
      </div>`;
    }).join('');
    el('m-grid').querySelectorAll('.m-row').forEach(c =>
      c.addEventListener('click', () => openModelEdit(c.dataset.id)));
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
      <div class="field two">
        ${modelField('Name', 'name', m && m.name, 'as bookers type it')}
        ${modelField('Nickname', 'nickname', m && m.nickname)}
      </div>
      <div id="md-name-warn" class="dup-warn" style="display:none"></div>
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
        const F = ['name', 'nickname', 'country', 'phone', 'whatsapp', 'line', 'email', 'ig', 'visaType', 'visaExpiry', 'workPermit', 'compCard', 'arrival', 'departure', 'note', 'motherAgency'];
        const cat = el('md-category').value === '—' ? '' : el('md-category').value;
        const data = { category: cat, agency: cat === 'MP Models' ? 'MP' : (cat ? 'Freelance' : ''), status: el('md-status').value === '—' ? '' : el('md-status').value, sex: el('md-sex').value === '—' ? '' : el('md-sex').value };
        F.forEach(k => data[k] = el('md-' + k).value);
        if (!data.name.trim()) { alert('Please enter a name.'); return; }
        const btn = el('md-save'); btn.disabled = true; btn.textContent = 'Saving…';
        try {
          if (m) { const r = await api('/api/models/' + m.id, { method: 'PATCH', body: JSON.stringify(data) }); Object.assign(m, r.model); }
          else {
            const r = await api('/api/models', { method: 'POST', body: JSON.stringify(data) });
            if (r.duplicate || !r.model) {            // server rejected a same-name model
              warnEl.style.display = 'block';
              warnEl.textContent = '⚠ ' + (r.error || 'That model is already on the list.');
              btn.disabled = false; btn.textContent = 'Add model';
              return;
            }
            models.push(r.model);
          }
          renderModels(); closeDrawer();
        } catch (_) { btn.disabled = false; btn.textContent = m ? 'Save' : 'Add model'; }
      });
      if (m) el('md-del').addEventListener('click', async () => {
        if (!confirm('Delete ' + m.name + ' from the directory?')) return;
        await api('/api/models/' + m.id, { method: 'DELETE' });
        models = models.filter(x => x.id !== m.id);
        renderModels(); closeDrawer();
      });
    }
    openDrawer();
  }
  el('m-add').addEventListener('click', () => openModelEdit(null));
  el('m-refresh').addEventListener('click', loadModels);
  ['m-search', 'm-country', 'm-sex'].forEach(idc => el(idc).addEventListener('input', renderModels));
  el('m-cat').addEventListener('change', () => { mCat = el('m-cat').value; renderModels(); });
  el('m-back').addEventListener('click', () => {
    mCat = ''; mStatus = '';
    el('m-search').value = ''; el('m-country').value = ''; el('m-cat').value = ''; el('m-sex').value = '';
    el('m-status-chips').querySelectorAll('.m-chip').forEach(x => x.classList.remove('active'));
    el('m-status-chips').querySelector('[data-st=""]').classList.add('active');
    renderModels();
  });
  el('m-status-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.m-chip'); if (!b) return;
    el('m-status-chips').querySelectorAll('.m-chip').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    mStatus = b.dataset.st;
    renderModels();
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
        <td>${esc(a.role === 'master' ? 'Director' : a.role === 'admin' ? 'Admin' : 'Booker')}</td>
        <td>${esc(a.action)}</td>
        <td>${esc(a.detail) || '—'}</td>
      </tr>`).join('');
  }
  ['a-type', 'a-user', 'a-search'].forEach(idc => el(idc).addEventListener('input', renderActivity));
  el('a-refresh').addEventListener('click', loadActivity);

  /* ================= 8. BOOT ================= */
  function start() { calMonth = todayLocal().slice(0, 7); showApp(); loadAll().catch(() => {}); }
  if (token) api('/api/jobs').then(() => start()).catch(() => showLogin());
  else showLogin();
})();
