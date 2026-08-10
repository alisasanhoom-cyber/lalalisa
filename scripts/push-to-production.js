#!/usr/bin/env node
/**
 * One-time: push your LOCAL data (jobs + schedule) straight to the deployed app.
 * Data goes directly from this machine to the server — never through GitHub.
 *
 * Usage:
 *   node scripts/push-to-production.js <APP_URL> <DIRECTOR_EMAIL> <DIRECTOR_PASSWORD>
 * Example:
 *   node scripts/push-to-production.js https://mp-booking.up.railway.app lisa@mpmodelsbkk.com 'MPdirector2026'
 */
const fs = require('fs');
const path = require('path');

const [, , baseUrl, email, password] = process.argv;
if (!baseUrl || !email || !password) {
  console.error('Usage: node scripts/push-to-production.js <APP_URL> <DIRECTOR_EMAIL> <DIRECTOR_PASSWORD>');
  process.exit(1);
}
const DATA = path.join(__dirname, '..', 'data');

(async () => {
  const login = await fetch(baseUrl.replace(/\/$/, '') + '/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const auth = await login.json();
  if (!auth.token) { console.error('Login failed:', auth.error || auth); process.exit(1); }
  if (auth.role !== 'master' && auth.role !== 'admin') { console.error('Not a manager account.'); process.exit(1); }

  const jobs = JSON.parse(fs.readFileSync(path.join(DATA, 'jobs.json'), 'utf8'));
  const schedule = JSON.parse(fs.readFileSync(path.join(DATA, 'schedule.json'), 'utf8'));
  // Passwords in users.json are already hashed (scrypt), so pushing the team's
  // real logins/names is safe — no plaintext leaves this machine.
  const users = JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8'));
  console.log(`Pushing ${jobs.length} jobs, ${schedule.length} leads and ${users.length} logins to ${baseUrl} …`);

  const res = await fetch(baseUrl.replace(/\/$/, '') + '/api/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': auth.token },
    body: JSON.stringify({ jobs, schedule, users }),
  });
  console.log('Done:', await res.json());
})().catch(e => { console.error(e.message); process.exit(1); });
