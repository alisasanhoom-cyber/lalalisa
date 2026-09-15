#!/usr/bin/env node
/*
 * RESTORE A WHOLE FILE FROM A MAC BACKUP (Director only) — audit 2026-09-15.
 * Puts jobs, schedule or models back onto the live app from one of the nightly
 * booking-YYYY-MM-DD.json files in /Users/lissa/MP-Backups. Shows the live count
 * and the backup count first and asks you to type YES. The server keeps a
 * .pre-restore copy of what it replaces.
 *
 *   node scripts/restore-from-backup.js /Users/lissa/MP-Backups/booking-2026-09-15.json schedule
 *   node scripts/restore-from-backup.js <backup.json> jobs|schedule|models [https://booking.mpmodelsbkk.com]
 * You will be asked for the Director email + password (nothing is stored).
 */
const fs = require('fs');
const readline = require('readline');
const [, , file, what, baseArg] = process.argv;
const BASE = (baseArg || 'https://booking.mpmodelsbkk.com').replace(/\/$/, '');
const KEY = { jobs: 'jobs.json', schedule: 'schedule.json', models: 'models.json' }[what];
if (!file || !KEY) { console.error('usage: restore-from-backup.js <backup.json> jobs|schedule|models [base-url]'); process.exit(2); }
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
const records = (backup.files || backup)[KEY];
if (!Array.isArray(records) || !records.length) { console.error(`${KEY} in ${file} is empty or missing — nothing to restore.`); process.exit(2); }
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));
(async () => {
  const email = (await ask('Director email: ')).trim();
  const password = await ask('Director password: ');
  const auth = await (await fetch(BASE + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
  if (!auth.token) { console.error('Login failed.'); process.exit(1); }
  const H = { 'Content-Type': 'application/json', 'x-admin-token': auth.token };
  const liveRaw = await (await fetch(BASE + '/api/' + what, { headers: H })).json();
  const live = Array.isArray(liveRaw) ? liveRaw : (liveRaw[what] || liveRaw.entries || []);
  console.log(`\nLIVE ${what}: ${live.length} records   |   BACKUP ${what} (${backup.when || file}): ${records.length} records`);
  if (records.length < live.length) console.log(`WARNING: the backup has ${live.length - records.length} FEWER records than live. Everything added since the backup will be gone.`);
  const yes = await ask('Replace the LIVE file with the backup? Type YES to continue: ');
  if (yes.trim() !== 'YES') { console.log('Cancelled — nothing changed.'); process.exit(0); }
  const r = await fetch(BASE + '/api/restore', { method: 'POST', headers: H, body: JSON.stringify({ [what]: records }) });
  console.log(r.ok ? `Restored ${records.length} ${what} records. The server kept a .pre-restore copy of the old file.` : 'Restore failed: ' + r.status + ' ' + await r.text());
  process.exit(r.ok ? 0 : 1);
})();
