#!/usr/bin/env node
/*
 * MP booking app — smoke tests. RUN BEFORE EVERY DEPLOY:  node tests/smoke.js
 * Boots the real server on a throwaway port + data dir and exercises the
 * money and permission invariants the team depends on, plus a truth table
 * for the client-side confirmation money code. Exit 0 = safe to deploy.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'smoketestkey';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-smoke-'));

// pre-seed users incl. a designer (prod adds Ploy manually; migrate hashes these)
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify([
  { email: 'lisa@mpmodelsbkk.com', name: 'Lisa (Director)', role: 'master', password: 'pw-master' },
  { email: 'booker@test', name: 'Booker T', role: 'booker', bookerName: 'BookerT', password: 'pw-booker' },
  { email: 'designer@test', name: 'Designer T', role: 'designer', password: 'pw-designer' },
]));

let failures = 0, tests = 0;
function check(name, cond, detail) {
  tests++;
  if (cond) console.log('  ✓', name);
  else { failures++; console.log('  ✗ FAIL:', name, detail !== undefined ? '— ' + JSON.stringify(detail).slice(0, 200) : ''); }
}
async function api(p, opts = {}, token) {
  const r = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-admin-token': token } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null; try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
}
async function login(email, password) {
  const r = await api('/api/auth', { method: 'POST', body: { email, password } });
  return r.body && r.body.token;
}

(async () => {
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, SERVICE_KEY: KEY },
    stdio: 'ignore',
  });
  try {
    // wait for boot
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/api/version'); up = r.ok; } catch (_) { await new Promise(r2 => setTimeout(r2, 250)); }
    }
    check('server boots', up);
    if (!up) throw new Error('no boot');

    console.log('— auth —');
    const master = await login('lisa@mpmodelsbkk.com', 'pw-master');
    check('master login', !!master);
    check('wrong password rejected', (await api('/api/auth', { method: 'POST', body: { email: 'lisa@mpmodelsbkk.com', password: 'nope' } })).status === 401);
    const booker = await login('booker@test', 'pw-booker');
    const designer = await login('designer@test', 'pw-designer');
    const scouter = await login('scouter@mpmodelsbkk.com', 'WolfMP2026scout');
    check('booker/designer/scouter logins', !!(booker && designer && scouter));

    console.log('— jobs & money —');
    const jr = await api('/api/jobs', { method: 'POST', body: { jobTitle: 'Smoke Job', model: 'Test Model', budget: 28000, currency: 'THB', jobId: 'C9999', jobDate: '2026-08-30', leadSource: 'LINE', clientCategory: 'Fashion', booker: 'BookerT' } }, booker);
    const jid = jr.body && jr.body.job && jr.body.job.id;
    check('booker creates job', !!jid);
    await api('/api/jobs/' + jid, { method: 'PATCH', body: { overtimeFee: '14000', overtimeRate: 3500, confirmationMade: true } }, booker);
    const exp1 = await api('/api/export', { headers: { 'x-service-key': KEY } });
    const row1 = (exp1.body.jobs || []).find(j => j.jobId === 'C9999');
    check('export = fee + numeric OT (42000)', row1 && row1.budget === 42000, row1 && row1.budget);
    check('export carries normalised month', row1 && row1.month === '2026-08', row1 && row1.month);
    check('export carries fx rates', !!(exp1.body.fx && exp1.body.fx.EUR));
    await api('/api/jobs/' + jid, { method: 'PATCH', body: { overtimeFee: '12,50' } }, booker);
    const row2 = ((await api('/api/export', { headers: { 'x-service-key': KEY } })).body.jobs || []).find(j => j.jobId === 'C9999');
    check('European "12,50" is condition text, not ฿1,250 (budget stays 28000)', row2 && row2.budget === 28000, row2 && row2.budget);

    console.log('— designer sandbox —');
    const dj = await api('/api/jobs', {}, designer);
    const djob = (dj.body.jobs || []).find(j => j.id === jid);
    check('designer sees monthly money (policy 2026-08-20)', djob && djob.budget === 28000);
    await api('/api/jobs/' + jid, { method: 'PATCH', body: { budget: 1, collected: true } }, designer);
    const after = ((await api('/api/jobs', {}, master)).body.jobs || []).find(j => j.id === jid);
    check('designer PATCH cannot change budget', after && after.budget === 28000, after && after.budget);
    check('designer PATCH can tick collected', after && after.collected === true);

    console.log('— PWA files —');
    const man = await fetch(BASE + '/manifest.webmanifest');
    let manBody = null; try { manBody = await man.json(); } catch (_) {}
    check('manifest served + valid JSON with icons', man.ok && manBody && Array.isArray(manBody.icons) && manBody.start_url === '/admin.html');
    const sw = await fetch(BASE + '/sw.js');
    const swText = sw.ok ? await sw.text() : '';
    check('sw.js served, never caches /api/', sw.ok && /startsWith\('\/api\/'\)/.test(swText));
    check('backend files still hidden (server.js 404)', (await fetch(BASE + '/server.js')).status === 404);

    console.log('— client job requests (public form) —');
    const rq = await api('/api/requests', { method: 'POST', body: { clientName: 'Test Client', lineId: '@test', projectType: 'Photoshoot', description: 'Lookbook' } });
    check('public request lands without login', rq.status === 201 && rq.body && rq.body.ok);
    const rqBad = await api('/api/requests', { method: 'POST', body: { clientName: 'No Contact Guy' } });
    check('request without any contact rejected', rqBad.status === 400);
    await api('/api/requests', { method: 'POST', body: { clientName: 'Bot', email: 'b@b.b', website: 'http://spam' } });
    const rqList = (await api('/api/requests', {}, booker)).body.requests || [];
    check('booker sees the request; honeypot submission NOT stored',
      rqList.some(r => r.clientName === 'Test Client' && r.status === 'new') && !rqList.some(r => r.clientName === 'Bot'), rqList.map(r => r.clientName));
    const rqId = (rqList.find(r => r.clientName === 'Test Client') || {}).id;
    const rqPatch = await api('/api/requests/' + rqId, { method: 'PATCH', body: { status: 'contacted', booker: 'Ness', clientName: 'HACKED' } }, booker);
    check('booker updates tracking fields; client answers untouchable',
      rqPatch.body && rqPatch.body.request && rqPatch.body.request.status === 'contacted' && rqPatch.body.request.clientName === 'Test Client');
    check('scouter cannot see requests', (await api('/api/requests', {}, scouter)).status === 403);
    check('request delete is manager-only', (await api('/api/requests/' + rqId, { method: 'DELETE' }, booker)).status === 403);

    console.log('— scouter sandbox —');
    const se = await api('/api/schedule', { method: 'POST', body: { date: '2026-09-01', endDate: '2026-11-30', models: 'Scout Test', subject: 'KAT Shanghai', place: 'China', planState: 'planned', stage: 'shooting' } }, scouter);
    const sid = se.body && se.body.entry && se.body.entry.id;
    check('scouter creates placement (range fields kept)', se.body && se.body.entry && se.body.entry.endDate === '2026-11-30' && se.body.entry.place === 'China');
    check('scouter cannot smuggle a board stage', se.body && se.body.entry && !se.body.entry.stage, se.body && se.body.entry && se.body.entry.stage);
    check('scouter entry tagged with his name + createdBy', se.body && se.body.entry && /scouter/i.test(se.body.entry.booker) && se.body.entry.createdBy === 'scouter@mpmodelsbkk.com');
    const be = await api('/api/schedule', { method: 'POST', body: { date: '2026-09-02', models: 'Someone', casting: 'Client X' } }, booker);
    const bid = be.body.entry.id;
    check('scouter cannot edit others\' entries', (await api('/api/schedule/' + bid, { method: 'PATCH', body: { note: 'hack' } }, scouter)).status === 403);
    check('scouter cannot delete others\' entries', (await api('/api/schedule/' + bid, { method: 'DELETE' }, scouter)).status === 403);
    check('scouter edits his own', (await api('/api/schedule/' + sid, { method: 'PATCH', body: { note: 'mine' } }, scouter)).status === 200);
    check('scouter blocked from bulk-tag', (await api('/api/schedule/bulk', { method: 'PATCH', body: { ids: [bid], booker: 'X' } }, scouter)).status === 403);

    console.log('— team-flow regressions —');
    const dead = await api('/api/jobs', { method: 'POST', body: { jobTitle: 'x' } }, 'dead-token-123');
    check('dead admin token on job create → 401 (not website-lead 400)', dead.status === 401, dead.status);
    const c1r = await api('/api/next-code', {}, booker);
    const c2r = await api('/api/next-code', {}, booker);
    check('two bookers never get the same next code', c1r.body && c2r.body && c1r.body.tax !== c2r.body.tax, [c1r.body && c1r.body.tax, c2r.body && c2r.body.tax]);
    const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const po = await api('/api/schedule', { method: 'POST', body: { date: past, models: 'Old Option', option: 'Client Y' } }, booker);
    await api('/api/schedule', {}, booker);   // GET triggers auto-decline
    let poNow = ((await api('/api/schedule', {}, booker)).body.schedule || []).find(e => e.id === po.body.entry.id);
    check('past option auto-declines', poNow && poNow.status === 'declined');
    await api('/api/schedule/' + po.body.entry.id, { method: 'PATCH', body: { status: 'open', keptOpen: true } }, booker);
    poNow = ((await api('/api/schedule', {}, booker)).body.schedule || []).find(e => e.id === po.body.entry.id);
    check('brought-back option STAYS open (keptOpen)', poNow && poNow.status === 'open', poNow && poNow.status);

    console.log('— settings —');
    await api('/api/settings', { method: 'PUT', body: { driveUploadUrl: 'https://example.com/exec', driveUploadKey: 'k' } }, master);
    const st = await api('/api/settings', {}, booker);
    check('booker receives drive settings', st.body && st.body.driveUploadUrl === 'https://example.com/exec' && st.body.driveUploadKey === 'k');
    const st2 = await api('/api/settings', { method: 'PUT', body: { fxRates: { EUR: 39 } } }, master);
    check('fx-only save keeps driveUploadUrl', st2.body && st2.body.driveUploadUrl === 'https://example.com/exec');
    check('booker cannot PUT settings', (await api('/api/settings', { method: 'PUT', body: { fxRates: { EUR: 1 } } }, booker)).status === 403);

    console.log('— confirmation money truth table (client code) —');
    global.window = global; global.location = { origin: BASE };
    eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'confirmation.js'), 'utf8'));
    const MP = global.MPConfirmation;
    const c1 = MP.calc({ budget: 28000, overtimeFee: '14000', overtimeRate: 3500, currency: 'THB' }, 'tax');
    check('tax math: 28000+14000 → vat 2940, total 44940, wht 1260, net 43680',
      c1.subtotal === 42000 && Math.round(c1.vat) === 2940 && Math.round(c1.total) === 44940 && Math.round(c1.wht) === 1260 && Math.round(c1.netPay) === 43680);
    check('OT display shows hourly basis', /4h × ฿3,500\/Hour/.test(c1.otDisplay), c1.otDisplay);
    check('EUR job hides WHT (auto)', MP.calc({ budget: 500, currency: 'EUR' }, 'tax').whtOn === false);
    check('whtMode on overrides for EUR', MP.calc({ budget: 500, currency: 'EUR', whtMode: 'on' }, 'tax').whtOn === true);
    const cText = MP.calc({ budget: 1000, overtimeFee: '12,50', currency: 'THB' }, 'tax');
    check('"12,50" never becomes money', cText.ot === 0 && cText.otDisplay === '12,50', cText.otDisplay);
    const cLines = MP.calc({ budget: 30000, overtimeFee: '5000', lines: [{ name: 'A', rate: 15000, ot: 0 }, { name: 'B', rate: 12000, ot: 3000 }] }, 'tax');
    check('lines job never double-counts job-level OT', cLines.subtotal === 30000, cLines.subtotal);
    const cMulti = MP.calc({ budget: 999, modelFees: [{ model: 'A', fee: '10,000' }, { model: 'B', fee: 10000 }] }, 'tax');
    check('legacy multi totals from modelFees (comma-safe)', cMulti.fee === 20000, cMulti.fee);
    check('nontax has no VAT', MP.calc({ budget: 1000 }, 'nontax').vat === 0);
    let ok1 = true; try { MP.render({}, 'tax'); MP.renderDrive({}, 'tax'); MP.sheetGrid({}, 'tax'); } catch (e) { ok1 = false; }
    check('render/renderDrive/sheetGrid never throw on empty job', ok1);
    const grid = MP.sheetGrid({ budget: 28000, overtimeFee: '14000', overtimeRate: 3500, currency: 'THB', jobId: 'C9999' }, 'tax');
    check('sheet grid carries the same OT line', grid.cells.some(c => /4h × ฿3,500\/Hour/.test(String(c.v))));

    console.log(`\n${tests - failures}/${tests} passed${failures ? ' — ' + failures + ' FAILURES, DO NOT DEPLOY' : ' — safe to deploy'}`);
    process.exitCode = failures ? 1 : 0;
  } catch (e) {
    console.error('SMOKE CRASH:', e.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
})();
