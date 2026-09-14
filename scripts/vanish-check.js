#!/usr/bin/env node
/*
 * VANISH CHECK — "how do we know if anything vanished?" (Lisa 2026-09-14)
 * Compares the two newest booking backups (or two files you name) and lists every
 * schedule entry / job that existed before and is gone now, with: is it in the
 * Trash (restorable), and which PERSON deleted it (Activity log). Anything gone
 * that is NOT in the trash or has no human delete line is flagged loudly.
 *
 *   node scripts/vanish-check.js /Users/lissa/MP-Backups          # two newest booking-*.json
 *   node scripts/vanish-check.js old.json new.json
 */
const fs = require('fs'); const path = require('path');
let [a, b] = process.argv.slice(2);
if (a && !b && fs.statSync(a).isDirectory()) {
  const files = fs.readdirSync(a).filter(f => /^booking-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (files.length < 2) { console.log('vanish-check: need two backups, found ' + files.length); process.exit(0); }
  b = path.join(a, files[files.length - 1]); a = path.join(a, files[files.length - 2]);
}
if (!a || !b) { console.error('usage: vanish-check.js <backup-dir> | <old.json> <new.json>'); process.exit(2); }
const load = f => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j.files || j; };
const oldB = load(a), newB = load(b);
const list = (bk, name) => { const v = bk[name]; return Array.isArray(v) ? v : []; };
const trash = list(newB, 'trash.json'), activity = list(newB, 'activity.json');
const tag = x => (x.date || x.jobDate || '') + ' ' + (x.models || x.model || x.jobTitle || '').slice(0, 40);
let flagged = 0, gone = 0;
const lines = [];
for (const [file, kind, label] of [['schedule.json', 'schedule', 'schedule entry'], ['jobs.json', 'job', 'job']]) {
  const now = new Set(list(newB, file).map(x => x.id));
  for (const x of list(oldB, file)) {
    if (now.has(x.id)) continue;
    gone++;
    const inTrash = trash.some(t => t.kind === kind && t.rec && t.rec.id === x.id);
    const del = activity.filter(l => l.action === 'deleted ' + kind && (l.detail || '').startsWith((x.date || x.jobTitle || '').slice(0, 10))).slice(-1)[0];
    const who = del ? `${del.name} at ${del.time.replace('T', ' ').slice(0, 16)} UTC` : 'NO human delete line';
    const ok = inTrash && del;
    if (!ok) flagged++;
    lines.push(`${ok ? '  ok ' : '  !! '}${label}: ${tag(x)} (${x.booker || ''}) — ${inTrash ? 'in Trash, restorable' : 'NOT IN TRASH'} — ${who}`);
  }
}
console.log(`vanish-check ${path.basename(a)} → ${path.basename(b)}: ${gone} gone, ${flagged} need a look`);
lines.forEach(l => console.log(l));
if (flagged) console.log('  !! ALERT: something is gone without a trash copy or a human delete — tell Lisa.');
