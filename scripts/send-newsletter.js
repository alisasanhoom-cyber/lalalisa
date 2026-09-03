#!/usr/bin/env node
/*
  Send the "Models in Town" newsletter through Lisa's own Gmail — no paid services.

  Usage:
    node scripts/send-newsletter.js --draft                # put the newsletter in Gmail Drafts
    node scripts/send-newsletter.js --test                 # send ONLY to lisa@ (preview)
    node scripts/send-newsletter.js --send                 # send today's batch (default 400)
    node scripts/send-newsletter.js --send --limit 500     # bigger batch
    node scripts/send-newsletter.js --status               # how many sent / remaining

  Needs a Gmail App Password in the GMAIL_APP_PASSWORD env var:
    GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx' node scripts/send-newsletter.js --test

  Progress is saved to ~/MP-Backups/newsletter-sep2026-sent.json after every
  email, so it is safe to stop and re-run — already-sent people are skipped.
*/

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const os = require('os');

const FROM_EMAIL = 'lisa@mpmodelsbkk.com';
const FROM_NAME = 'Lisa — Morgan & Preston Models Bangkok';
const SUBJECT = 'Models in Town — September to November 2026';
const HTML_FILE = path.join(__dirname, '..', 'newsletter-sep2026.html');
const LIST_DIR = path.join(os.homedir(), 'Documents', 'mailchimp clients lists');
const SUBSCRIBED = path.join(LIST_DIR, 'subscribed_email_audience_export_11c81c33fc.csv');
const UNSUBSCRIBED = path.join(LIST_DIR, 'unsubscribed_email_audience_export_11c81c33fc.csv');
const CLEANED = path.join(LIST_DIR, 'cleaned_email_audience_export_11c81c33fc.csv');
const SENT_LOG = path.join(os.homedir(), 'MP-Backups', 'newsletter-sep2026-sent.json');
const DELAY_MS = 4000; // pause between emails — keeps Gmail happy

/* ---------- tiny CSV reader (handles quoted fields with commas) ---------- */
function csvEmails(file) {
  const text = fs.readFileSync(file, 'utf8');
  const emails = [];
  for (const line of text.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const first = line[0] === '"' ? line.slice(1, line.indexOf('"', 1)) : line.split(',')[0];
    const e = first.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) emails.push(e);
  }
  return emails;
}

/* ---------- minimal SMTP client for smtp.gmail.com:465 ---------- */
function smtpSend(auth, to, mime) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' });
    let buffer = '';
    const steps = [
      { expect: 220, send: () => `EHLO mpmodelsbkk.com\r\n` },
      { expect: 250, send: () => `AUTH LOGIN\r\n` },
      { expect: 334, send: () => Buffer.from(auth.user).toString('base64') + '\r\n' },
      { expect: 334, send: () => Buffer.from(auth.pass).toString('base64') + '\r\n' },
      { expect: 235, send: () => `MAIL FROM:<${auth.user}>\r\n` },
      { expect: 250, send: () => `RCPT TO:<${to}>\r\n` },
      { expect: 250, send: () => `DATA\r\n` },
      { expect: 354, send: () => mime + '\r\n.\r\n' },
      { expect: 250, send: () => `QUIT\r\n`, done: true },
    ];
    let i = 0, finished = false;
    const fail = (msg) => { if (!finished) { finished = true; sock.destroy(); reject(new Error(msg)); } };
    sock.setTimeout(30000, () => fail('SMTP timeout'));
    sock.on('error', (e) => fail(e.message));
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      // a complete SMTP reply ends with "NNN " at the start of the final line
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return; // multi-line reply still coming
      const code = parseInt(last.slice(0, 3), 10);
      buffer = '';
      if (i >= steps.length) return;
      const step = steps[i];
      if (code !== step.expect) return fail(`SMTP step ${i}: expected ${step.expect}, got ${code} ${last.slice(4)}`);
      if (step.done) { finished = true; sock.end(); return resolve(); }
      sock.write(steps[i++].send());
    });
  });
}

function buildMime(to, html) {
  const boundary = 'mp' + Date.now().toString(36);
  const plain = `Models in Town - September to November 2026.\r\n` +
    `23 women and 11 men are on our Bangkok board this season.\r\n` +
    `View online: https://booking.mpmodelsbkk.com/newsletter-sep2026.html\r\n` +
    `If you prefer not to receive model updates, just reply "unsubscribe".`;
  // base64 keeps every mail client from mangling the HTML
  const html64 = Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${FROM_NAME} <${FROM_EMAIL}>`,
    `To: <${to}>`,
    `Subject: ${SUBJECT}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    plain,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    html64,
    `--${boundary}--`,
  ].join('\r\n');
}

/* ---------- IMAP APPEND: place a full-fidelity draft in Gmail Drafts ---------- */
function imapCreateDraft(auth, mime) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(993, 'imap.gmail.com', { servername: 'imap.gmail.com' });
    let buffer = '', stage = 0, finished = false;
    const fail = (msg) => { if (!finished) { finished = true; sock.destroy(); reject(new Error(msg)); } };
    sock.setTimeout(30000, () => fail('IMAP timeout'));
    sock.on('error', (e) => fail(e.message));
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      if (stage === 0 && /^\* OK/m.test(buffer)) {
        buffer = '';
        stage = 1;
        sock.write(`a1 LOGIN "${auth.user}" "${auth.pass}"\r\n`);
      } else if (stage === 1 && /^a1 /m.test(buffer)) {
        if (!/^a1 OK/m.test(buffer)) return fail('IMAP login failed — check the app password');
        buffer = '';
        stage = 2;
        sock.write(`a2 APPEND "[Gmail]/Drafts" (\\Draft) {${Buffer.byteLength(mime)}}\r\n`);
      } else if (stage === 2 && buffer.includes('+')) {
        buffer = '';
        stage = 3;
        sock.write(mime + '\r\n');
      } else if (stage === 3 && /^a2 /m.test(buffer)) {
        if (!/^a2 OK/m.test(buffer)) return fail('IMAP APPEND failed: ' + buffer.trim());
        finished = true;
        sock.write('a3 LOGOUT\r\n');
        sock.end();
        resolve();
      }
    });
  });
}

/* ---------- main ---------- */
(async () => {
  const args = process.argv.slice(2);
  const mode = args.includes('--test') ? 'test' : args.includes('--send') ? 'send'
    : args.includes('--draft') ? 'draft' : args.includes('--status') ? 'status' : 'help';
  if (mode === 'help') {
    console.log('Usage: --test | --send [--limit N] | --status  (see top of file)');
    process.exit(0);
  }

  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx > -1 ? parseInt(args[limitIdx + 1], 10) : 400;

  let sent = {};
  try { sent = JSON.parse(fs.readFileSync(SENT_LOG, 'utf8')); } catch (_) {}

  const skip = new Set([...csvEmails(UNSUBSCRIBED), ...csvEmails(CLEANED)]);
  const list = [...new Set(csvEmails(SUBSCRIBED))].filter(e => !skip.has(e));
  const remaining = list.filter(e => !sent[e]);

  if (mode === 'status') {
    console.log(`List: ${list.length} valid subscribers (${skip.size} unsubscribed/bounced excluded)`);
    console.log(`Sent: ${Object.keys(sent).length} — Remaining: ${remaining.length}`);
    process.exit(0);
  }

  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!pass) {
    console.error('Missing GMAIL_APP_PASSWORD. Create one at https://myaccount.google.com/apppasswords');
    process.exit(1);
  }
  const auth = { user: FROM_EMAIL, pass };
  const html = fs.readFileSync(HTML_FILE, 'utf8');

  if (mode === 'draft') {
    await imapCreateDraft(auth, buildMime(FROM_EMAIL, html));
    console.log('Draft created — open Gmail > Drafts. The newsletter is there with all pictures.');
    return;
  }

  const targets = mode === 'test' ? [FROM_EMAIL] : remaining.slice(0, limit);
  console.log(mode === 'test'
    ? `TEST — sending only to ${FROM_EMAIL}`
    : `Sending to ${targets.length} of ${remaining.length} remaining (limit ${limit})`);

  let ok = 0, failed = 0;
  for (const to of targets) {
    try {
      await smtpSend(auth, to, buildMime(to, html));
      ok++;
      if (mode === 'send') {
        sent[to] = new Date().toISOString();
        fs.writeFileSync(SENT_LOG, JSON.stringify(sent, null, 1));
      }
      console.log(`  ok   ${to}  (${ok}/${targets.length})`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${to} — ${e.message}`);
      if (/5\.7\.|Daily user sending limit|Too many/i.test(e.message)) {
        console.log('Gmail is rate-limiting — stopping for today. Re-run tomorrow; progress is saved.');
        break;
      }
    }
    if (targets.length > 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }
  console.log(`Done: ${ok} sent, ${failed} failed.` +
    (mode === 'send' ? ` ${remaining.length - ok} still remaining — re-run tomorrow.` : ''));
})();
