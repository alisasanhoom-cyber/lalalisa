// E2E — schedule add/edit TYPE flows in the REAL page (headless Chrome via CDP).
// RUN BEFORE EVERY DEPLOY next to smoke.js:  node tests/e2e-schedule.js
// Boots server.js on a throwaway port + data dir; needs Google Chrome installed.
// Guards the class of bug "the type I clicked is not the type that was saved"
// (43 re-typed entries in 5 weeks before 2026-09-14).
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 4611, BASE = `http://127.0.0.1:${PORT}`, CDP = 9333;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-e2e-'));
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify([
  { email: 'admin@test', name: 'Admin', role: 'admin', bookerName: 'Admin', password: 'pw' },
  { email: 'booker@test', name: 'Tawa', role: 'booker', bookerName: 'Tawa', password: 'pw' },
]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, SERVICE_KEY: 'k' }, stdio: 'ignore' });
const chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-chrome-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${chromeDir}`, '--no-first-run', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
let failures = 0;
// WATCHDOG: a hung browser or a promise that never settles must fail the run, never
// block a deploy for hours (2026-09-18: one run sat idle for 25 minutes).
setTimeout(() => {
  console.error('\nTIMEOUT: the browser flows did not finish within 10 minutes — treating as FAILED');
  try { chrome.kill(); } catch (_) {} try { server.kill(); } catch (_) {}
  process.exit(1);
}, 10 * 60 * 1000).unref();
const check = (n, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : '  ' + extra)); if (!ok) failures++; };
(async () => {
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/version')).ok) break; } catch (_) {} await sleep(250); }
    const tokens = {};
    for (const u of ['admin@test', 'booker@test']) { const r = await (await fetch(BASE + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u, password: 'pw' }) })).json(); if (!r.token) throw new Error('login failed ' + u); tokens[u] = r; }
    let auth = tokens['booker@test'];
    let targets; for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); if (targets.length) break; } catch (_) {} await sleep(250); }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    let id = 0; const pending = {};
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    await send('Page.enable');
    await send('Page.navigate', { url: BASE + '/admin.html' }); await sleep(1500);
    const loginAs = async (email, role, name) => {
      auth = tokens[email];
      await ev(`sessionStorage.setItem('mp_admin_token', ${JSON.stringify(auth.token)}); sessionStorage.setItem('mp_admin_role','${role}'); sessionStorage.setItem('mp_admin_name','${name}'); sessionStorage.setItem('mp_admin_bookername','${name}'); sessionStorage.setItem('mp_admin_email','${email}'); 'ok'`);
      await send('Page.navigate', { url: BASE + '/admin.html' }); await sleep(2500);
      await ev(`window.alert = m => { window.__alerts = (window.__alerts||[]).concat(m); }; window.__confirms = []; window.__confirmAnswer = true; window.confirm = m => { window.__confirms.push(m); return window.__confirmAnswer; }; 'ok'`);
      const loggedIn = await ev(`getComputedStyle(document.getElementById('login')).display`);
      check('logged in as ' + name, loggedIn === 'none', loggedIn);
      await ev(`document.querySelector('.tab[data-view="schedule"]').click(); 'ok'`); await sleep(500);
    };
    await loginAs('booker@test', 'booker', 'Tawa');

    const openAdd = async () => { await ev(`document.getElementById('s-add').click(); 'ok'`); await sleep(400); };
    const clickDay = async d => { const ok = await ev(`(()=>{const c=document.querySelector('.mc-cell[data-d="${d}"]'); if(!c) return 'nocell'; c.click(); return 'ok';})()`); if (ok !== 'ok') throw new Error('no cell ' + d); await sleep(150); };
    const clickBrush = async b => { await ev(`document.querySelector('#brush-btns .cat-btn[data-brush="${b}"]').click(); 'ok'`); await sleep(150); };
    const fill = async (details, models) => ev(`document.getElementById('d-details').value=${JSON.stringify(details)}; document.getElementById('d-models').value=${JSON.stringify(models)}; document.getElementById('d-sleadSource').value='LINE'; 'ok'`);
    const summary = () => ev(`document.getElementById('stage-summary').innerText`);
    const save = async () => { await ev(`document.getElementById('d-save').click(); 'ok'`); await sleep(1200); };
    const entries = async () => (await (await fetch(BASE + '/api/schedule', { headers: { 'x-admin-token': auth.token } })).json());
    const findAll = (list, date) => (Array.isArray(list) ? list : list.entries || list.schedule || []).filter(e => e.date === date);

    console.log('— A: Aim\'s flow: click the day FIRST, then Priority (the bug) —');
    await openAdd(); await clickDay('2026-09-15'); await clickBrush('priority');
    const sumA = await summary(); check('summary shows the day under Priority', /Priority/.test(sumA) && !/Job|Shooting/.test(sumA), sumA);
    await fill('Rosa arrive at 10 am', ''); await save();
    const A = findAll(await entries(), '2026-09-15');
    check('one entry created on 15', A.length === 1, JSON.stringify(A).slice(0, 200));
    check('saved as Priority (priority text set, job empty, not shooting)', A[0] && A[0].priority === 'Rosa arrive at 10 am' && !A[0].job && A[0].stage !== 'shooting', A[0] && JSON.stringify({ stage: A[0].stage, job: A[0].job, priority: A[0].priority }));

    console.log('— B: multi-stage plan (type chosen first, then days) still keeps each stage —');
    await openAdd(); await clickBrush('casting'); await clickDay('2026-09-16'); await clickBrush('fitting'); await clickDay('2026-09-17');
    const sumB = await summary(); check('summary keeps Casting 16 + Fitting 17', /Casting:.*16/.test(sumB) && /Fitting:.*17/.test(sumB), sumB);
    await fill('MITR plan', 'Simone L'); await save();
    const all = await entries();
    const B16 = findAll(all, '2026-09-16'), B17 = findAll(all, '2026-09-17');
    check('16 = casting', B16.length === 1 && B16[0].casting === 'MITR plan' && !B16[0].fitting && !B16[0].job, JSON.stringify(B16).slice(0, 150));
    check('17 = fitting', B17.length === 1 && B17[0].fitting === 'MITR plan' && !B17[0].casting && !B17[0].job, JSON.stringify(B17).slice(0, 150));

    console.log('— C: day painted, type never clicked → stays a Job (unchanged) —');
    await openAdd(); await clickDay('2026-09-18'); await fill('Plain job', 'Kiana'); await save();
    const C = findAll(await entries(), '2026-09-18');
    check('18 = job/shooting', C.length === 1 && C[0].stage === 'shooting' && C[0].job === 'Plain job', JSON.stringify(C).slice(0, 150));

    console.log('— D: day first, Priority, then a second day painted by hand → both Priority —');
    await openAdd(); await clickDay('2026-09-21'); await clickBrush('priority'); await clickDay('2026-09-22');
    const sumD = await summary(); check('summary: Priority 21 + 22', /Priority:.*21.*22/.test(sumD) && !/Job|Shooting/.test(sumD), sumD);
    await fill('Visa run', ''); await save();
    const all2 = await entries();
    check('21 + 22 both priority', ['2026-09-21', '2026-09-22'].every(d => { const x = findAll(all2, d); return x.length === 1 && x[0].priority === 'Visa run' && !x[0].job; }));

    console.log('— E: change of mind: Shortlist → day 23 → Option → save: asks, OK → saved as Option —');
    await openAdd(); await clickBrush('shortlist'); await clickDay('2026-09-23'); await clickBrush('option');
    await fill('Hold for Lolane', 'Kiana'); await save();
    const confE = await ev(`JSON.stringify(window.__confirms)`);
    check('asked before saving (mentions Option and Shortlist)', /Option/.test(confE) && /Shortlist/.test(confE), confE);
    const E = findAll(await entries(), '2026-09-23');
    check('23 saved as Option, not Shortlist', E.length === 1 && E[0].option === 'Hold for Lolane' && !E[0].shortlist, JSON.stringify(E).slice(0, 160));

    console.log('— F: incomplete plan: Casting → day 24 → Fitting (no day) → save, Cancel → nothing saved, form stays open —');
    await openAdd(); await clickBrush('casting'); await clickDay('2026-09-24'); await clickBrush('fitting');
    await ev(`window.__confirms = []; window.__confirmAnswer = false; 'ok'`);
    await fill('MITR', 'Elina'); await save();
    const F = findAll(await entries(), '2026-09-24');
    const askedF = await ev(`window.__confirms.length`); const formOpen = await ev(`!!document.getElementById('d-save')`);
    check('asked, nothing saved, form still open', askedF === 1 && F.length === 0 && formOpen, JSON.stringify({ askedF, n: F.length, formOpen }));
    await ev(`window.__confirmAnswer = true; 'ok'`);
    await ev(`document.getElementById('d-close').click(); 'ok'`); await sleep(300);

    console.log('— G: edit drawer: second click on the active type keeps it (no silent Note) —');
    await ev(`(()=>{const m=document.getElementById('s-month'); if(![...m.options].some(o=>o.value==='2026-09')) m.add(new Option('2026-09','2026-09')); m.value='2026-09'; m.dispatchEvent(new Event('change')); return m.value;})()`);
    await ev(`document.getElementById('s-cal-btn').click(); 'ok'`); await sleep(500);
    const diag = await ev(`JSON.stringify({cells: document.querySelectorAll('.cal-cell').length, dated: [...document.querySelectorAll('[data-date]')].slice(0,3).map(x=>x.className+'|'+x.dataset.date), tab: document.querySelector('.tab.active')?.dataset.view, calBtn: document.getElementById('s-cal-btn')?.className, drawerOpen: document.getElementById('drawer').classList.contains('open'), sched: !!document.querySelector('#view-schedule, [data-view-panel=schedule]')})`); console.log('diag:', diag);
    await ev(`(document.querySelector('.cal-cell[data-date="2026-09-18"]') || document.querySelector('[data-date="2026-09-18"]')).click(); 'ok'`); await sleep(500);
    const cardHit = await ev(`(()=>{const cs=[...document.querySelectorAll('#s-board [data-key]')]; const c=cs.find(x=>x.dataset.key==='${C[0].id}')||cs[0]; if(!c) return 'nocard'; const k=c.dataset.key; c.click(); return 'clicked '+k+' (want ${C[0].id})';})()`); await sleep(600);
    console.log('  board card:', cardHit);
    const editOpened = await ev(`(()=>{const b=document.querySelector('.day-edit'); if(!b) return false; b.click(); return true;})()`); await sleep(500);
    check('edit drawer opened for 18', editOpened);
    await ev(`document.querySelector('.cat-btn[data-cat="job"]').click(); 'ok'`); await sleep(150);
    const stillActive = await ev(`document.querySelector('.cat-btn[data-cat="job"]').classList.contains('active')`);
    check('Job still active after second click', stillActive === true);
    await ev(`document.getElementById('d-details').value = 'Plain job (edited)'; document.getElementById('d-save').click(); 'ok'`); await sleep(1200);
    const G = findAll(await entries(), '2026-09-18');
    check('18 still a Job after edit (not a note)', G.length === 1 && G[0].job === 'Plain job (edited)' && !G[0].note, JSON.stringify(G).slice(0, 160));

    console.log('— I: Create job from a schedule entry: shoot date = the entry\'s day; entry stays, nothing added on today —');
    await openAdd(); await clickBrush('shooting'); await clickDay('2026-09-26'); await fill('CCOO shoot', 'Boho, Uliana'); await save();
    const I0 = findAll(await entries(), '2026-09-26'); check('job entry on 26 created', I0.length === 1);
    await ev(`document.getElementById('s-cal-btn').click(); 'ok'`); await sleep(400);
    await ev(`document.querySelector('.cal-cell[data-date="2026-09-26"]').click(); 'ok'`); await sleep(500);
    await ev(`[...document.querySelectorAll('#s-board [data-key]')].find(x=>x.dataset.key==='${I0[0].id}').click(); 'ok'`); await sleep(500);
    const mk = await ev(`(()=>{const b=document.querySelector('.make-job'); if(!b) return false; b.click(); return true;})()`); await sleep(600);
    check('Create job opened the job form', mk === true && (await ev(`!!document.getElementById('d-jobTitle')`)));
    const picked = await ev(`document.getElementById('d-picked')?.innerText || ''`);
    check('shoot-date picker starts on 26 Sep (the entry\'s day)', /26 Sep/.test(picked), picked);
    await ev(`document.getElementById('d-leadSource').value='LINE'; document.getElementById('d-clientCategory').value='Commercial'; document.getElementById('d-save').click(); 'ok'`); await sleep(2000);
    const jobsRaw = await (await fetch(BASE + '/api/jobs', { headers: { 'x-admin-token': auth.token } })).json();
    const jobs = Array.isArray(jobsRaw) ? jobsRaw : (jobsRaw.jobs || []);
    const job = jobs.find(j => j.jobTitle === 'CCOO shoot');
    check('job saved with shootDates = [26 Sep]', !!job && JSON.stringify(job.shootDates) === JSON.stringify(['2026-09-26']), job && JSON.stringify(job.shootDates));
    const allI = await entries(); const I1 = findAll(allI, '2026-09-26'), Itoday = findAll(allI, '2026-09-14');
    check('26 Sep entry still there, same entry, linked to the job', I1.length === 1 && I1[0].id === I0[0].id && job && I1[0].jobRef === job.id, JSON.stringify(I1.map(e=>({id:e.id,jobRef:e.jobRef}))));
    check('nothing created on today (14 Sep)', Itoday.length === 0, JSON.stringify(Itoday).slice(0,120));

    console.log('— J: change the job\'s shoot date 26 → 27: 26 (hand-made) stays, unlinked; 27 auto-created —');
    await ev(`document.querySelector('.tab[data-view="jobs"]').click(); 'ok'`); await sleep(500);
    const rowHit = await ev(`(()=>{const r=document.querySelector('tr[data-id="${job && job.id}"]'); if(!r) return false; r.click(); return true;})()`); await sleep(600);
    check('job row opened', rowHit === true);
    await ev(`document.querySelector('#d-picker .mc-cell[data-d="2026-09-26"]').click(); 'ok'`); await sleep(150);
    await ev(`document.querySelector('#d-picker .mc-cell[data-d="2026-09-27"]').click(); 'ok'`); await sleep(150);
    await ev(`document.getElementById('d-save').click(); 'ok'`); await sleep(2000);
    const allJ = await entries(); const J26 = findAll(allJ, '2026-09-26'), J27 = findAll(allJ, '2026-09-27');
    check('26 Sep hand-made entry NOT deleted, just unlinked', J26.length === 1 && J26[0].id === I0[0].id && !J26[0].jobRef, JSON.stringify(J26.map(e=>({id:e.id,jobRef:e.jobRef}))));
    check('27 Sep auto entry created and marked autoShoot', J27.length === 1 && J27[0].autoShoot === true && J27[0].jobRef === job.id, JSON.stringify(J27).slice(0,160));

    console.log('— J2: postpone the shoot 27 → 28: the program\'s own card MOVES (same card), nothing deleted —');
    await ev(`document.querySelector('.tab[data-view="jobs"]').click(); 'ok'`); await sleep(400);
    await ev(`document.querySelector('tr[data-id="${job && job.id}"]').click(); 'ok'`); await sleep(600);
    await ev(`document.querySelector('#d-picker .mc-cell[data-d="2026-09-27"]').click(); document.querySelector('#d-picker .mc-cell[data-d="2026-09-28"]').click(); document.getElementById('d-save').click(); 'ok'`); await sleep(2000);
    const allJ2 = await entries(); const J2_27 = findAll(allJ2, '2026-09-27'), J2_28 = findAll(allJ2, '2026-09-28');
    check('27 card moved to 28 (same id), 27 empty', J2_27.length === 0 && J2_28.length === 1 && J2_28[0].id === J27[0].id && J2_28[0].jobRef === job.id, JSON.stringify({ n27: J2_27.length, n28: J2_28.map(e => e.id) }));

    console.log('— K: delete the job: NOTHING on the schedule is deleted — cards stay, unlinked —');
    const del = await fetch(BASE + '/api/jobs/' + job.id, { method: 'DELETE', headers: { 'x-admin-token': auth.token } });
    check('job deleted', del.ok, String(del.status));
    const allK = await entries();
    check('28 card still there, unlinked', findAll(allK, '2026-09-28').length === 1 && !findAll(allK, '2026-09-28')[0].jobRef);
    check('26 hand-made entry still there', findAll(allK, '2026-09-26').length === 1);

    console.log('— H: Admin account: form opens on Priority; day → save = Priority —');
    await loginAs('admin@test', 'admin', 'Admin');
    await openAdd();
    const defBrush = await ev(`document.querySelector('#brush-btns .cat-btn.active')?.dataset.brush`);
    check('default type for Admin is Priority', defBrush === 'priority', defBrush);
    await clickDay('2026-09-25'); await fill('Garnet arrive', ''); await save();
    const H = findAll(await entries(), '2026-09-25');
    check('25 saved as Priority with no type click at all', H.length === 1 && H[0].priority === 'Garnet arrive' && !H[0].job, JSON.stringify(H).slice(0, 160));

    console.log('— L: a booker deletes an entry (human click) → the Director restores it from the Trash screen —');
    await loginAs('booker@test', 'booker', 'Tawa');
    const L0 = findAll(await entries(), '2026-09-26'); check('entry on 26 exists before delete', L0.length === 1);
    const delR = await fetch(BASE + '/api/schedule/' + L0[0].id, { method: 'DELETE', headers: { 'x-admin-token': auth.token } });
    check('booker delete accepted', delR.ok); check('26 gone after the human delete', findAll(await entries(), '2026-09-26').length === 0);
    await loginAs('admin@test', 'admin', 'Admin');
    await ev(`document.querySelector('.tab[data-view="activity"]').click(); 'ok'`); await sleep(400);
    await ev(`document.getElementById('a-trash').click(); 'ok'`); await sleep(800);
    const rowsL = await ev(`[...document.querySelectorAll('#trash-rows tr')].map(r => r.innerText.replace(/\\s+/g, ' '))`);
    check('Trash screen lists the deleted 26 Sep entry with who deleted it', rowsL.some(r => /Schedule entry/.test(r) && /2026-09-26/.test(r) && /Boho, Uliana/.test(r) && /booker/.test(r)), JSON.stringify(rowsL).slice(0, 200));
    await ev(`[...document.querySelectorAll('#trash-rows tr')].find(r => /Schedule entry/.test(r.innerText) && /2026-09-26/.test(r.innerText)).querySelector('.trash-restore').click(); 'ok'`); await sleep(3500);
    const L1 = findAll(await entries(), '2026-09-26');
    check('26 Sep entry is back, same id, same content', L1.length === 1 && L1[0].id === L0[0].id && L1[0].job === L0[0].job, JSON.stringify(L1).slice(0, 160));
    check('row left the Trash list', !(await ev(`[...document.querySelectorAll('#trash-rows tr')].some(r => /Schedule entry/.test(r.innerText) && /2026-09-26/.test(r.innerText))`)));

    console.log('— M: text in a SECOND type field survives a save from the edit drawer (156 legacy entries) —');
    await loginAs('booker@test', 'booker', 'Tawa');
    const post = async body => (await (await fetch(BASE + '/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': auth.token }, body: JSON.stringify(body) })).json()).entry;
    const legacy = await post({ date: '2026-09-29', models: 'Legacy Two', job: 'Thai Post brief', shortlist: 'Hyesun', booker: 'Tawa', status: 'open' });
    const openEditOf = async (date, key) => {
      // Entries created through the API are not in the page's memory yet — nudge the
      // 20-second silent refresh (it also runs on window focus) and wait for it.
      await ev(`window.dispatchEvent(new Event('focus')); 'ok'`); await sleep(1500);
      await ev(`document.querySelector('.tab[data-view="schedule"]').click(); 'ok'`); await sleep(300);
      await ev(`(()=>{const m=document.getElementById('s-month'); if(![...m.options].some(o=>o.value==='2026-09')) m.add(new Option('2026-09','2026-09')); m.value='2026-09'; m.dispatchEvent(new Event('change')); return m.value;})()`);
      await ev(`document.getElementById('s-cal-btn').click(); 'ok'`); await sleep(400);
      await ev(`document.getElementById('s-cal-btn').click(); 'ok'`); await sleep(400);
      await ev(`(()=>{const c=document.querySelector('.cal-cell[data-date="${date}"]'); if(c) c.click(); return !!c;})()`); await sleep(600);
      let hit = false;
      for (let i = 0; i < 15 && !hit; i++) {   // the board renders from a feed that loads async after a login — poll for the card
        hit = await ev(`(()=>{const c=[...document.querySelectorAll('#s-board [data-key]')].find(x=>x.dataset.key==='${key}'); if(!c) return false; c.click(); return true;})()`);
        if (!hit) await sleep(400);
      }
      await sleep(800);
      const ed = await ev(`(()=>{const b=document.querySelector('.day-edit'); if(!b) return false; b.click(); return true;})()`); await sleep(600);
      if (!(hit && ed)) console.log('  diag openEditOf:', JSON.stringify({ key, hit, ed, cells: await ev(`document.querySelectorAll('.cal-cell[data-date]').length`), cards: await ev(`[...document.querySelectorAll('#s-board [data-key]')].map(x=>x.dataset.key+'|'+x.innerText.slice(0,30))`), tab: await ev(`document.querySelector('.tab.active')?.dataset.view`), boardDay: await ev(`document.getElementById('b-date')?.value || document.querySelector('#s-board .board-day, #b-day')?.innerText`) }).slice(0, 600));
      return hit && ed;
    };
    check('edit drawer opened for the legacy entry', await openEditOf('2026-09-29', legacy.id));
    await ev(`document.getElementById('d-details').value = 'Thai Post brief v2'; document.getElementById('d-save').click(); 'ok'`); await sleep(1200);
    const M1 = findAll(await entries(), '2026-09-29').find(e => e.id === legacy.id);
    check('job text updated AND hidden shortlist text kept', M1 && M1.job === 'Thai Post brief v2' && M1.shortlist === 'Hyesun', M1 && JSON.stringify({ job: M1.job, shortlist: M1.shortlist }));

    console.log('— O: clicking Priority in the drawer does not change the booker —');
    check('edit drawer reopened', await openEditOf('2026-09-29', legacy.id));
    await ev(`document.querySelector('.cat-btn[data-cat="priority"]').click(); 'ok'`); await sleep(150);
    const bookerAfter = await ev(`document.getElementById('d-sbooker') ? document.getElementById('d-sbooker').value : '(none)'`);
    check('booker still Tawa after the Priority click', bookerAfter === 'Tawa', bookerAfter);
    await ev(`document.getElementById('d-close').click(); 'ok'`); await sleep(300);

    console.log('— N: editing one day of a hold changes shared info on the other day but never its own time —');
    const hg = 'hg-e2e-' + Date.now();
    const h1 = await post({ date: '2026-09-30', models: 'Hold Pair', option: 'hold brief', booker: 'Tawa', holdGroup: hg, holdStart: '2026-09-30', holdEnd: '2026-10-01', timeStart: '10:00' });
    const h2 = await post({ date: '2026-10-01', models: 'Hold Pair', option: 'hold brief', booker: 'Tawa', holdGroup: hg, holdStart: '2026-09-30', holdEnd: '2026-10-01', timeStart: '14:00' });
    check('edit drawer opened for day 1 of the hold', await openEditOf('2026-09-30', hg));
    await ev(`document.getElementById('d-models').value = 'Hold Pair Updated'; document.getElementById('d-save').click(); 'ok'`); await sleep(1500);
    const allN = await entries(); const N1 = findAll(allN, '2026-09-30').find(e => e.id === h1.id), N2 = findAll(allN, '2026-10-01').find(e => e.id === h2.id);
    check('day 2 got the new models (shared info follows the hold)', N2 && N2.models === 'Hold Pair Updated', N2 && N2.models);
    check('day 2 kept its OWN time 14:00; day 1 kept 10:00', N2 && N2.timeStart === '14:00' && N1 && N1.timeStart === '10:00', JSON.stringify({ d1: N1 && N1.timeStart, d2: N2 && N2.timeStart }));

    console.log('— P: one type rule everywhere: an entry in the Options column is an Option to the Reminders too —');
    const tmr = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const optWithJobText = await post({ date: tmr, models: 'Yogurt Models', job: 'Job: Yogurt', subject: 'Job: Yogurt', stage: 'option', booker: 'Tawa' });
    const realJob = await post({ date: tmr, models: 'Coway Models', job: 'Job: Coway', subject: 'Job: Coway', stage: 'shooting', status: 'confirmed', booker: 'Tawa' });
    check('tomorrow\'s two entries were created', !!(optWithJobText && optWithJobText.id && realJob && realJob.id), JSON.stringify({ a: optWithJobText, b: realJob }).slice(0, 200));
    console.log('  api has for tomorrow:', findAll(await entries(), tmr).length);
    await ev(`document.querySelector('.tab[data-view="schedule"]').click(); 'ok'`); await sleep(300);
    const refreshed = await ev(`(()=>{const b=document.getElementById('s-refresh'); if(b){b.click(); return 'clicked';} window.dispatchEvent(new Event('focus')); return 'focus';})()`); await sleep(2500);
    console.log('  refresh via:', refreshed);
    await ev(`(()=>{const l=document.getElementById('rem-launcher'); if(l) l.click(); return !!l;})()`); await sleep(400);
    const remRows = await ev(`[...document.querySelectorAll('.rem-row')].map(r => r.innerText.replace(/\\s+/g, ' '))`);
    if (!remRows.length) console.log('  diag reminders:', JSON.stringify({ box: await ev(`(document.getElementById('s-reminders')||{}).innerHTML?.slice(0,200)`), launcher: await ev(`(document.getElementById('rem-launcher')||{}).style?.display`), tmr, n: await ev(`document.querySelectorAll('.rem-row').length`) }));
    check('Options-column entry is NOT in tomorrow\'s reminders', !remRows.some(r => /Yogurt/.test(r)), JSON.stringify(remRows).slice(0, 200));
    check('Shooting-column entry IS listed, labelled JOB', remRows.some(r => /Coway/.test(r) && /JOB/.test(r)), JSON.stringify(remRows).slice(0, 200));

    console.log('— Q: Schedule has a Year picker; the month list holds one year; Whole year shows the booker\'s year —');
    await ev(`document.querySelector('.tab[data-view="schedule"]').click(); 'ok'`); await sleep(300);
    const yearVal = await ev(`document.getElementById('s-year').value`);
    const monthOpts = await ev(`[...document.getElementById('s-month').options].map(o => o.value)`);
    check('year picker defaults to this year', yearVal === String(new Date().getFullYear()), yearVal);
    check('month list = Whole year + 12 months of that year only', monthOpts.length === 13 && monthOpts[0] === 'all' && monthOpts.slice(1).every(v => v.startsWith(yearVal + '-')), JSON.stringify(monthOpts));
    await ev(`(()=>{const m=document.getElementById('s-month'); m.value='all'; m.dispatchEvent(new Event('change')); document.getElementById('s-cal-btn').click(); return 'ok';})()`); await sleep(500);
    const yoTitle = await ev(`document.querySelector('.cal-title')?.innerText || ''`);
    check('Whole year shows the year overview for the chosen year', new RegExp(yearVal + ' · year overview').test(yoTitle), yoTitle);
    await ev(`(()=>{const y=document.getElementById('s-year'); if(![...y.options].some(o=>o.value==='2025')) y.add(new Option('2025','2025')); y.value='2025'; y.dispatchEvent(new Event('change')); return 'ok';})()`); await sleep(500);
    const monthOpts25 = await ev(`[...document.getElementById('s-month').options].map(o => o.value)`);
    check('switching the year rebuilds the month list for that year', monthOpts25.length === 13 && monthOpts25.slice(1).every(v => v.startsWith('2025-')), JSON.stringify(monthOpts25).slice(0, 120));

    const alerts = await ev(`JSON.stringify(window.__alerts||[])`); console.log('alerts during run:', alerts);
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  } catch (e) { console.error('ERROR', e.message); failures++; }
  finally { chrome.kill(); server.kill(); await sleep(800); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); fs.rmSync(chromeDir, { recursive: true, force: true, maxRetries: 5 }); process.exit(failures ? 1 : 0); }
})();
