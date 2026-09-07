#!/usr/bin/env node
/*
  Models-in-Town "EASY" newsletter — image embedded inline (no remote URLs).

  STEP 1:  GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx' node scripts/send-easy.js --test
           → sends ONLY to lisa@mpmodelsbkk.com, then stop.
  STEP 2:  GMAIL_APP_PASSWORD='...' node scripts/send-easy.js --send
           → one email: To lisa@, BCC everyone in ~/Downloads/clients_bcc.txt.

  Needs: ~/Downloads/newsletter_EASY.jpg  and  ~/Downloads/clients_bcc.txt
*/

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const os = require('os');

const FROM_EMAIL = 'lisa@mpmodelsbkk.com';
const FROM_NAME = 'Lisa — Morgan & Preston Models Bangkok';
const SUBJECT = 'MP MODELS — Models in Town · September–November 2026';
const IMAGE = path.join(os.homedir(), 'Downloads', 'newsletter_EASY.jpg');
const BCC_FILE = path.join(os.homedir(), 'Downloads', 'clients_bcc.txt');
const WOMEN = 'https://mpmodelsbkk.mediaslide.com/package/view/124/b20a7252/174/d84c3345';
const MEN = 'https://mpmodelsbkk.mediaslide.com/package/view/125/24c249c3/178/d84c3345';

function buildHtml() {
  return `<div style="margin:0;padding:0;background:#f4f4f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0;"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" style="background:#ffffff;">
<tr><td align="center" style="padding:0;">
<img src="cid:newsletter" width="500" style="width:500px;max-width:100%;display:block;border:0;" alt="Models in Town — September to November 2026">
</td></tr>
<tr><td align="center" style="padding:20px 32px 8px;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
<td style="background:#111111;padding:14px 30px;"><a href="${WOMEN}" style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:2px;color:#ffffff;text-decoration:none;">VIEW WOMEN &#8594;</a></td>
<td style="width:12px;"></td>
<td style="background:#111111;padding:14px 30px;"><a href="${MEN}" style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:2px;color:#ffffff;text-decoration:none;">VIEW MEN &#8594;</a></td>
</tr></table></td></tr>
<tr><td align="center" style="padding:16px 32px 26px;"><div style="font-family:Arial,sans-serif;font-size:13px;color:#555555;line-height:1.7;">Interested in any face? Simply <a href="mailto:${FROM_EMAIL}" style="color:#111111;">reply with the model's name</a> &#8212;<br>we confirm availability and rates within the day.</div></td></tr>
<tr><td style="background:#f0efed;padding:18px 32px;text-align:center;"><div style="font-family:Arial,sans-serif;font-size:11px;color:#999999;line-height:1.7;">MORGAN &amp; PRESTON MODELS BANGKOK &#183; Leo Classic Place, 249 Sukhumvit 49, Bangkok<br>+66 2-130-0357 &#183; www.mpmodelsbkk.com &#183; IG @mpmodelsbkk<br>If you prefer not to receive model updates, just reply &quot;unsubscribe&quot;.</div></td></tr>
</table></td></tr></table></div>`;
}

function b64wrap(buf) {
  return buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function buildMime() {
  const img = fs.readFileSync(IMAGE);
  const rel = 'rel' + Date.now().toString(36);
  const alt = 'alt' + Date.now().toString(36);
  const plain = `Models in Town - September to November 2026.\r\n` +
    `View women: ${WOMEN}\r\nView men: ${MEN}\r\n` +
    `Interested in any face? Simply reply with the model's name - we confirm availability and rates within the day.\r\n` +
    `If you prefer not to receive model updates, just reply "unsubscribe".`;
  return [
    `From: ${FROM_NAME} <${FROM_EMAIL}>`,
    `To: <${FROM_EMAIL}>`,
    `Subject: ${SUBJECT}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/related; boundary="${rel}"`,
    ``,
    `--${rel}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    ``,
    `--${alt}`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    plain,
    `--${alt}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64wrap(Buffer.from(buildHtml(), 'utf8')),
    `--${alt}--`,
    ``,
    `--${rel}`,
    `Content-Type: image/jpeg; name=newsletter.jpg`,
    `Content-Transfer-Encoding: base64`,
    `Content-ID: <newsletter>`,
    `Content-Disposition: inline; filename=newsletter.jpg`,
    ``,
    b64wrap(img),
    `--${rel}--`,
  ].join('\r\n');
}

/* ---------- minimal SMTP client, multiple recipients ---------- */
function smtpSend(auth, recipients, mime) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' });
    const steps = [
      { expect: 220, send: `EHLO mpmodelsbkk.com\r\n` },
      { expect: 250, send: `AUTH LOGIN\r\n` },
      { expect: 334, send: Buffer.from(auth.user).toString('base64') + '\r\n' },
      { expect: 334, send: Buffer.from(auth.pass).toString('base64') + '\r\n' },
      { expect: 235, send: `MAIL FROM:<${auth.user}>\r\n` },
      ...recipients.map(r => ({ expect: 250, send: `RCPT TO:<${r}>\r\n` })),
      { expect: 250, send: `DATA\r\n` },
      { expect: 354, send: mime + '\r\n.\r\n' },
      { expect: 250, send: `QUIT\r\n`, done: true },
    ];
    let buffer = '', i = 0, finished = false;
    const fail = (msg) => { if (!finished) { finished = true; sock.destroy(); reject(new Error(msg)); } };
    sock.setTimeout(120000, () => fail('SMTP timeout'));
    sock.on('error', (e) => fail(e.message));
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      const code = parseInt(last.slice(0, 3), 10);
      buffer = '';
      if (i >= steps.length) return;
      const step = steps[i];
      if (code !== step.expect) return fail(`SMTP: expected ${step.expect}, got ${code} ${last.slice(4)}`);
      if (step.done) { finished = true; sock.end(); return resolve(); }
      sock.write(steps[i++].send);
    });
  });
}

(async () => {
  const mode = process.argv.includes('--test') ? 'test'
    : process.argv.includes('--send') ? 'send' : 'help';
  if (mode === 'help') { console.log('Usage: --test | --send  (see top of file)'); return; }

  if (!fs.existsSync(IMAGE)) { console.error(`Missing image: ${IMAGE}`); process.exit(1); }
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!pass) { console.error('Missing GMAIL_APP_PASSWORD env var.'); process.exit(1); }
  const auth = { user: FROM_EMAIL, pass };

  let recipients = [FROM_EMAIL];
  if (mode === 'send') {
    if (!fs.existsSync(BCC_FILE)) { console.error(`Missing BCC list: ${BCC_FILE}`); process.exit(1); }
    const bcc = [...new Set(fs.readFileSync(BCC_FILE, 'utf8').split('\n')
      .map(l => l.trim().toLowerCase())
      .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))]
      .filter(e => e !== FROM_EMAIL);
    if (!bcc.length) { console.error('BCC list is empty after validation.'); process.exit(1); }
    recipients = [FROM_EMAIL, ...bcc];
    console.log(`Sending one email: To ${FROM_EMAIL} + BCC ${bcc.length} clients...`);
  } else {
    console.log(`TEST — sending only to ${FROM_EMAIL}...`);
  }

  await smtpSend(auth, recipients, buildMime());
  console.log(mode === 'send'
    ? `Done: sent to ${recipients.length} recipients total (1 To + ${recipients.length - 1} BCC).`
    : 'Test sent. Check your inbox.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
