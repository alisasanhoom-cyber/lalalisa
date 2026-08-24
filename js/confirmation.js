/* ===================================================================
   JOB CONFIRMATION FORMS  (used by admin.html)
   -------------------------------------------------------------------
   Reproduces the three official MP Models confirmation forms:
     - tax     : domestic tax invoice (7% VAT, Chonburi head office)
     - nontax  : non-tax form (Bangkok office, no VAT)
     - intl    : international tax form (like tax, no contact-number field)

   Call:  MPConfirmation.open(job, 'tax' | 'nontax' | 'intl')
   It opens a print-ready page in a new tab (Print → Save as PDF to send).
   =================================================================== */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const baht = n => '฿' + Math.round(Number(n || 0)).toLocaleString('en-US');

  /* ---- What differs between the three forms ---- */
  // Money math for a confirmation — ONE place, used by build() and exposed to
  // admin.js so the Drive spreadsheet shows exactly the same numbers.
  function calc(job, type) {
    const v = VARIANTS[type] || VARIANTS.tax;
    const num = x => { const n = parseFloat(String(x == null ? '' : x).replace(/[^\d.]/g, '')); return isNaN(n) ? 0 : n; };
    // Lines-jobs already fold each model's OT into budget; legacy shared-code
    // groups carry the real total only in modelFees — never in this record's
    // budget. Either way, a job-level numeric overtimeFee must NOT add again.
    const hasLines = Array.isArray(job.lines) && job.lines.length > 0;
    const feesMulti = Array.isArray(job.modelFees) && job.modelFees.length > 1;
    const fee = feesMulti ? job.modelFees.reduce((s, mf) => s + num(mf.fee), 0) : num(job.budget);
    // Strict thousands format: "12,50" (European decimal comma) is condition
    // text, not ฿1,250 — ambiguous strings never become money.
    const otNumeric = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(String(job.overtimeFee || '').trim());
    const otIsNumber = otNumeric && !hasLines && !feesMulti;
    const ot = otIsNumber ? num(job.overtimeFee) : 0;      // only add overtime to the total if it's a number
    const subtotal = fee + ot;                             // fee + overtime, before VAT
    const vat = v.vat ? subtotal * 0.07 : 0;
    const total = subtotal + vat;                          // invoice total (incl VAT)
    // Corporate THAI clients withhold 3% tax on the service fee. FOREIGN clients
    // cannot issue a Thai withholding certificate (Aim's rule) — showing "−3%"
    // just tempts them to underpay, so it auto-hides for foreign-currency jobs.
    // job.whtMode overrides: 'on' = always show, 'off' = always hide, '' = auto.
    const whtOn = job.whtMode === 'on' || (job.whtMode !== 'off' && v.vat && (job.currency || 'THB') === 'THB');
    const wht = whtOn ? subtotal * 0.03 : 0;
    const netPay = total - wht;                            // what a withholding client transfers
    const sym = { THB: '฿', USD: '$', EUR: '€', CNY: '¥' }[job.currency] || '฿';
    const cash = n => sym + Math.round(Number(n || 0)).toLocaleString('en-US');
    // Overtime display: incurred amount → condition text → hourly rate (Ness:
    // clients should always see the OT price per hour, like the old form).
    const otRate = num(job.overtimeRate);
    // Display: incurred amount WITH its hourly basis (Aim: the client must see
    // the rate even when a fee is charged, e.g. "฿14,000 — 4h × ฿3,500/Hour")
    // → else the booker's condition text → else the plain hourly rate. A stale
    // NUMBER on a lines/multi job is hidden (its OT sits inside the fees).
    const otText = otNumeric && !otIsNumber ? '' : String(job.overtimeFee || '').trim();
    let otDisplay;
    if (otIsNumber) {
      let basis = '';
      if (otRate > 0) {
        const h = Math.round((ot / otRate) * 2) / 2;   // hours in half-hour steps
        basis = Math.abs(ot - h * otRate) < 1 && h > 0
          ? ' — ' + h + 'h × ' + cash(otRate) + '/Hour'
          : ' (' + cash(otRate) + '/Hour)';
      }
      otDisplay = cash(ot) + basis;
    } else {
      otDisplay = otText || (otRate ? cash(otRate) + '/Hour' : '');
    }
    return { v, num, fee, otIsNumber, ot, subtotal, vat, total, whtOn, wht, netPay, sym, cash, otDisplay };
  }

  const VARIANTS = {
    tax: {
      title: 'Tax Invoice Form',
      company: 'Morgan & Preston Co., Ltd. (Head office)',
      address: '144/214 Moo 12, Nongprue, Banglamung, Chonburi 20150',
      taxId: '0205556027160', tel: '+662-130 0357',
      vat: true, contactNumber: true,
      bank: 'Kasikorn Bank, Ekamai Branch — Account #: 030-126168-3',
      accountName: 'Morgan & Preston Co., Ltd.',
      cancellation: 'A 50% of job fee will be charged for cancellation after job confirm. A 100% of job fee will be charged for cancellation received within 24 hours prior to the scheduled shooting date or within a day of shooting.',
    },
    nontax: {
      title: 'Non-Tax Form',
      company: 'Morgan & Preston Co., Ltd. (Head office)',
      address: '20/14 PromSri Alley, Khlong Tan Nuea, Watthana, Bangkok 10110',
      taxId: '', tel: '+662-130 0357',
      vat: false, contactNumber: true,
      bank: 'SCB — Account number: 406-6-35187-5',
      accountName: 'Morgan & Preston Co., Ltd.',
      cancellation: 'A 50% of job fee will be charged for cancellation after job confirm. A 100% of job fee will be charged for cancellation received within 24 hours prior to the scheduled shooting date or within a day of shooting.',
    },
    intl: {
      title: 'International Tax Form',
      company: 'Morgan & Preston Co., Ltd. (Head office)',
      address: '144/214 Moo 12, Nongprue, Banglamung, Chonburi 20150',
      taxId: '0205556027160', tel: '+662-130 0357',
      vat: true, contactNumber: false,
      bank: 'Kasikorn Bank, Ekamai Branch — Account #: 030-126168-3',
      accountName: 'Morgan & Preston Co., Ltd.',
      cancellation: 'A 50% of job fee will be charged for cancellation after job confirm. A 100% of job fee will be charged for cancellation received within 24 hours prior to the scheduled shooting date or within a day of shooting.',
    },
  };

  // A realistic filled-in example used by MPConfirmation.sample() so bookers can
  // see exactly what a completed confirmation looks like (fields, fees, layout).
  const SAMPLE_JOB = {
    jobTitle: 'Sample Brand — Photo & VDO Shoot', model: 'Model Name', freelance: '',
    jobId: 'C0000', jobIdNonTax: '', booker: 'Booker name',
    budget: '50,000', currency: 'THB', overtimeFee: '',
    companyName: 'Sample Client Co., Ltd.', client: 'Sample Client',
    clientTaxId: '0105500000000', companyAddress: '123 Example Road, Watthana, Bangkok 10110',
    contactPerson: 'Contact Person', contactNumber: '02-000 0000', clientEmail: 'client@example.com',
    notes: 'Campaign shoot for new product launch', product: 'Sample product', role: 'Featured model',
    mediaUsage: 'Online + social media', periodOfUsage: '1 year', countryOfUse: 'Thailand',
    shootLocation: 'Studio, Bangkok', shootStart: '2026-09-01', shootEnd: '2026-09-01', remark: '',
    timeStart: '09:00', timeEnd: '17:00', contractHours: '8', noOfShoot: '1', paymentTerm: '30 days',
  };

  const ACK = 'The Client/Advertiser as specified in this confirmation of model booking agrees, acknowledge and accept that:';
  const TERMS = [
    'The fees are excluded 7% government VAT.',
    'For late payment, MP Models by Morgan & Preston Co., Ltd. has the rights to charge the outstanding amount plus 10% rolling interest applicable from the first day of late payment onwards.',
    'Overtime will not be charged if less than 30 minutes. If overtime exceeds 30 minutes, it will be counted as 1 hour.',
    'If additional usages of this advertisement are required in the future, the client agrees to negotiate such additional usages and related fees to us prior to release. Failure to do so will result in client being liable to pay a penalty per model up to 200K THB.',
    "The client agrees to guarantee the model's safety and will be fully responsible for any medical expenses and compensation as a result of injury or accident during working time or travel to location.",
    'All the masterworks being produced in accordance for specifications described in this model booking shall not be transferred physically or deemed legally transferred. Nor shall it be broadcasted electronically or by any other means made available to the public or utilized in any misused manner whatsoever in any places or countries in the world to the public, clients and/or advertisers unless payment specified in this agreement has been made in full to MP Models by Morgan & Preston Co., Ltd.',
    'The clients/advertisers as specified in this booking confirmation hereby agreed not to transfer the jobs to a third party or make any additional usage of the model or materials produced under this confirmation other than specified above. Any additional usages shall be negotiated and/or notified prior to such usage and will be used only with a written consent from MP Models by Morgan & Preston Co., Ltd.',
    "In the event that masterwork produced as described in this confirmation of model booking is in contradiction to these provisions or the legal or moral rights of MP Models by Morgan & Preston Co., Ltd., its agents, employees, models or representatives, then any such contradictions shall be deemed a violation of the performer's rights to the greatest extent permitted by law.",
    'It will indemnify MP Models by Morgan & Preston Co., Ltd. for any loss whatsoever incurred as a direct or consequential result of the violation of this acknowledgement agreement.',
    'The Client shall not use, reproduce, modify, manipulate, adapt, train, input into any artificial intelligence system, or create any synthetic media, AI-generated content, deepfake content, digital replica, or similar technology utilizing the Model’s image, likeness, voice, identity, or any identifiable characteristics, without the Model’s prior written consent. Any unauthorized use shall constitute a material breach of this Agreement. In the event of such breach, the Client agrees to pay liquidated damages in an amount equal to one hundred (100) times the Model’s agreed compensation rate for the original engagement, without prejudice to any additional legal remedies available.',
  ];

  // one label + value pair (value blank = a fillable underline)
  const field = (label, value, span = 1) =>
    `<div class="f" style="grid-column:span ${span}"><span class="fl">${label}</span><span class="fv">${esc(value) || '&nbsp;'}</span></div>`;

  // Pick a sensible default form type from the job's code.
  function defaultType(job) {
    if (job && job.jobIdNonTax && !job.jobId) return 'nontax';
    return 'tax';
  }

  function build(job, type, opts) {
    opts = opts || {};
    const hideMoney = opts.hideMoney;
    const sample = opts.sample;
    const v = VARIANTS[type] || VARIANTS.tax;
    const code = type === 'nontax'
      ? (job.jobIdNonTax || job.jobId || '')
      : (job.jobId || job.jobIdNonTax || '');
    const issued = new Date().toISOString().slice(0, 10);
    const models = (Array.isArray(job.modelFees) && job.modelFees.length > 1)
      ? job.modelFees.map(mf => mf.model).filter(Boolean).join(', ')
      : [job.model, job.freelance].filter(Boolean).join(', ');
    // The PDF file name comes from the page <title>: "CODE - Job name - Models" —
    // the code goes FIRST (Aim's request: LINE truncates long names, and the code
    // is the one part that must always be visible). Strip filename-unsafe chars.
    const clean = s => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const codeShort = (String(code).match(/[CB]\s?\d+/i) || [String(code)])[0].replace(/\s/g, '');
    const fileTitle = [codeShort, clean(job.jobTitle), clean(models)].filter(Boolean).join(' - ') || ('Job Confirmation ' + codeShort);
    build.lastTitle = fileTitle;   // exposed so admin.js can name the Word/Drive copy
    // All money math lives in calc() — shared with admin.js (Drive spreadsheet).
    const pay = calc(job, type);
    const num = pay.num, fee = pay.fee, otIsNumber = pay.otIsNumber, ot = pay.ot,
      subtotal = pay.subtotal, vat = pay.vat, total = pay.total,
      whtOn = pay.whtOn, wht = pay.wht, netPay = pay.netPay;
    const logo = location.origin + '/images/mp-logo.png';
    const sig = location.origin + '/images/lisa-signature.jpg';
    // Money in the job's currency (THB ฿ / USD $ / EUR € / CNY ¥).
    const sym = pay.sym, cash = pay.cash;
    // Overtime shows: the incurred amount → the booker's condition text → or the
    // plain hourly rate ("฿1,250/Hour") so the client always sees the OT price.
    const otDisplay = pay.otDisplay;

    // Multiple models on one job (each their own fee) → a per-model fee table.
    const multi = Array.isArray(job.modelFees) && job.modelFees.length > 1 ? job.modelFees : null;
    let feeBlock;
    if (multi) {
      const rows = multi.map(mf => {
        const f = num(mf.fee), fvat = v.vat ? f * 0.07 : 0, ft = f + fvat;
        return `<tr><td class="mf-name">${esc(mf.model || '—')}</td>`
          + `<td class="mf-num">${f ? cash(f) : '—'}</td>`
          + (v.vat ? `<td class="mf-num">${f ? cash(fvat) : '—'}</td>` : '')
          + `<td class="mf-num"><b>${f ? cash(ft) : '—'}</b></td></tr>`;
      }).join('');
      const sumFee = multi.reduce((s, mf) => s + num(mf.fee), 0);
      const sumVat = v.vat ? sumFee * 0.07 : 0;
      const grand = sumFee + sumVat;
      const sumWht = whtOn ? sumFee * 0.03 : 0;
      const netGrand = grand - sumWht;
      feeBlock = `
      <table class="mf-table">
        <tr class="mf-head"><th>Model</th><th class="mf-num">Fee${v.vat ? ' (excl. VAT)' : ''}</th>${v.vat ? '<th class="mf-num">VAT 7%</th>' : ''}<th class="mf-num">Total</th></tr>
        ${rows}
        <tr class="mf-total"><td>TOTAL (${multi.length} models)</td><td class="mf-num">${cash(sumFee)}</td>${v.vat ? `<td class="mf-num">${cash(sumVat)}</td>` : ''}<td class="mf-num"><b>${cash(grand)}</b></td></tr>
      </table>
      ${otDisplay ? `<p class="pay"><b>Overtime:</b> ${esc(otDisplay)}</p>` : ''}
      ${whtOn ? `<div class="row cols2 wht-row">${field('Less withholding tax 3%', '− ' + cash(sumWht))}${field('Net amount to transfer', cash(netGrand))}</div>
      <p class="wht-note">If you withhold tax (companies), transfer the <b>net amount ${cash(netGrand)}</b> and issue us a 3% withholding-tax certificate. Otherwise transfer the full total ${cash(grand)}.</p>`
      : (v.vat ? `<p class="wht-note">Please transfer the <b>full total ${cash(grand)}</b>.</p>` : '')}`;
    } else if (v.vat) {
      feeBlock = `
      <div class="row cols4">
        ${field('Fee (Excluding 7% VAT)', fee ? cash(fee) : '')}
        ${field('Overtime Fee', otDisplay)}
        ${field('Subtotal', subtotal ? cash(subtotal) : '')}
        ${field('VAT 7%', subtotal ? cash(vat) : '')}
      </div>
      <div class="row cols1 total-row">
        ${field('Total Payment Amount (incl. 7% VAT)', total ? cash(total) : '')}
      </div>
      ${whtOn ? `<div class="row cols2 wht-row">
        ${field('Less withholding tax 3%', subtotal ? '− ' + cash(wht) : '')}
        ${field('Net amount to transfer', total ? cash(netPay) : '')}
      </div>
      <p class="wht-note">If you withhold tax (companies), transfer the <b>net amount ${cash(netPay)}</b> and issue us a 3% withholding-tax certificate. Otherwise transfer the full total ${cash(total)}.</p>`
      : `<p class="wht-note">Please transfer the <b>full total ${cash(total)}</b>.</p>`}`;
    } else {
      feeBlock = `
      <div class="row cols2">
        ${field('Fee', fee ? cash(fee) : '')}
        ${field('Overtime Fee', otDisplay)}
      </div>
      <div class="row cols1 total-row">
        ${field('Total Payment Amount', total ? cash(total) : '')}
      </div>`;
    }

    return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(fileTitle)}</title>
<style>
  *{box-sizing:border-box}
  @page{size:A4;margin:6mm}
  html,body{margin:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;font-size:9.5px;line-height:1.24}
  @media screen{body{padding:20px 26px;max-width:800px;margin:0 auto}}
  .print-btn{position:fixed;top:12px;right:12px;background:#1b998b;color:#fff;border:none;padding:8px 15px;border-radius:8px;font-size:13px;cursor:pointer;z-index:5}
  .hint{position:fixed;top:12px;left:12px;background:#fff4e0;border:1px solid #ecc98a;color:#7a4d0a;padding:9px 13px;border-radius:9px;font-size:12px;max-width:340px;line-height:1.4;box-shadow:0 4px 14px rgba(0,0,0,.14)}
  .hint b{color:#8a2b00}
  @media print{.print-btn,.hint{display:none}}
  .head{display:flex;flex-direction:column;align-items:center;gap:4px;border-bottom:2px solid #1b998b;padding-bottom:7px;text-align:center}
  .head img{height:38px}
  .co b{font-size:12px} .co{font-size:9px;color:#444;line-height:1.45}
  .title{text-align:center;font-size:15px;letter-spacing:.12em;font-weight:700;margin:6px 0 2px}
  .topmeta{display:flex;justify-content:flex-end;gap:22px;font-size:9px;margin-bottom:5px}
  .topmeta b{color:#1b998b}
  .sect{background:#1a1a1a;color:#fff;font-size:9px;letter-spacing:.05em;font-weight:700;padding:2px 7px;margin:6px 0 3px;text-transform:uppercase}
  .row{display:grid;gap:3px 12px;margin-bottom:2px}
  .cols1{grid-template-columns:1fr} .cols2{grid-template-columns:1fr 1fr}
  .cols3{grid-template-columns:1fr 1fr 1fr} .cols4{grid-template-columns:1fr 1fr 1fr 1fr}
  .f{display:flex;flex-direction:column;min-width:0}
  .fl{font-size:7px;text-transform:uppercase;letter-spacing:.02em;color:#888;margin-bottom:0}
  .fv{border-bottom:1px solid #cfcfcf;padding:0 0 1px;min-height:13px;font-weight:600;font-size:10px;white-space:pre-wrap;word-break:break-word}
  .total-row .f{background:#f4f3ee;border:1px solid #cfcfcf;border-radius:5px;padding:4px 10px}
  .total-row .fl{color:#333}
  .total-row .fv{border-bottom:none;font-size:13px;font-weight:800;padding:0}
  .mf-table{width:100%;border-collapse:collapse;margin:2px 0 4px;font-size:9px}
  .mf-table th,.mf-table td{border:1px solid #d7d4c8;padding:3px 7px;text-align:left}
  .mf-table .mf-head th{background:#faf9f5;font-size:7px;text-transform:uppercase;letter-spacing:.03em;color:#666;font-weight:700}
  .mf-table .mf-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .mf-table .mf-name{font-weight:600}
  .mf-table .mf-total td{background:#f4f3ee;font-weight:800;border-top:2px solid #1a1a1a}
  .pay{font-size:8.5px;margin:2px 0} .pay b{color:#1a1a1a}
  .wht-row{margin-top:4px}
  .wht-row .f{background:#f4f3ee;border:1px solid #cfcfcf;border-radius:5px;padding:4px 10px}
  .wht-row .fv{border-bottom:none;font-weight:800;padding:0;font-size:12px}
  .wht-row .f:last-child .fv{color:#1b998b}
  .wht-note{font-size:8px;color:#555;margin:3px 0 0}
  .ack{font-size:7.4px;color:#444;line-height:1.28;margin-top:5px}
  .ack ol{padding-left:13px;margin:3px 0} .ack li{margin-bottom:1.8px}
  /* Signature block follows the terms with a modest gap (no forced bottom-anchor, which
     used to spill the signature onto a 2nd page). Kept whole on the page. */
  .sign{display:flex;gap:30px;margin-top:20px;padding-top:50px;break-inside:avoid;page-break-inside:avoid}
  .sign div{flex:1;border-top:1px solid #666;padding-top:6px;text-align:center;font-size:9px;color:#333;position:relative}
  /* Signature image sits above the line; padding-top on .sign (50px) exceeds its height (34px) so it never overlaps the terms above. */
  .sig-img{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);height:34px;margin-bottom:3px}
  .foot{margin-top:20px;font-size:7.5px;color:#aaa;text-align:center}
  /* On the printed sheet, pin the footer to the very bottom of the page. */
  @media print{.foot{position:fixed;bottom:4mm;left:0;right:0;margin:0}}
  /* SAMPLE preview: a clear ribbon + diagonal watermark so it's never mistaken for a real client doc. */
  .sample-ribbon{background:#b91c1c;color:#fff;text-align:center;font-weight:800;font-size:11px;letter-spacing:.14em;padding:5px;border-radius:6px;margin-bottom:8px}
  .sample-wm{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:0}
  .sample-wm span{font-size:110px;font-weight:900;color:rgba(185,28,28,.08);transform:rotate(-32deg);letter-spacing:.1em;white-space:nowrap}
  body>*{position:relative;z-index:1}
</style></head><body>
${sample ? '<div class="sample-wm"><span>SAMPLE</span></div>' : ''}
<button class="print-btn" onclick="window.print()">Print / Save PDF</button>
<div class="hint"><b>Before you save/print:</b> in the print box open <b>More settings</b> → turn <b>“Headers and footers” OFF</b>. This removes the date, page title and <i>about:blank</i> lines so the client sees a clean form. You only set it once — the browser remembers it.</div>

${sample ? '<div class="sample-ribbon">SAMPLE — EXAMPLE LAYOUT ONLY · NOT A REAL CONFIRMATION</div>' : ''}
<div class="head">
  <img src="${logo}" alt="MP" onerror="this.style.display='none'">
  <div class="co">
    <b>${esc(v.company)}</b><br>
    ${esc(v.address)}<br>
    ${v.taxId ? 'Tax ID: ' + esc(v.taxId) + ' &nbsp;·&nbsp; ' : ''}Tel: ${esc(v.tel)}
  </div>
</div>

<div class="title">CONFIRMATION</div>
<div class="topmeta">
  <span>Date: <b>${issued}</b></span>
  <span>Job ID: <b>${esc(code) || '—'}</b></span>
  <span>Booker: <b>${esc(job.booker) || '—'}</b></span>
</div>

<div class="sect">Client Company Details</div>
<div class="row cols2">
  ${field('Company Name', job.companyName || job.client)}
  ${field('Tax ID', job.clientTaxId)}
</div>
<div class="row cols1">${field('Company Address', job.companyAddress)}</div>
<div class="row cols3">
  ${field('Contact Person', job.contactPerson || job.clientName)}
  ${field('Contact Number', job.contactNumber || job.phone)}
  ${field('Email', job.clientEmail || job.email)}
</div>

<div class="sect">Job Details</div>
<div class="row cols1">${field('Assignment Title', job.jobTitle)}</div>
<div class="row cols2">
  ${field('Assignment Description', job.notes)}
  ${field('Product', job.product)}
</div>
<div class="row cols2">
  ${field('Model Name and Surname', models)}
  ${field('Role', job.role)}
</div>
<div class="row cols2">
  ${field('Media Usage', job.mediaUsage)}
  ${field('Period of Usage', job.periodOfUsage)}
</div>
<div class="row cols2">
  ${field('Country/ies of Use', job.countryOfUse)}
  ${field('Shooting Location', job.shootLocation)}
</div>
<div class="row cols3">
  ${field('Date of Shoot (Start)', job.shootStart || job.jobDate)}
  ${field('Date of Shoot (End)', job.shootEnd)}
  ${field('Remark', job.remark)}
</div>
<div class="row cols4">
  ${field('Time of Shoot (Start)', job.timeStart)}
  ${field('Time of Shoot (End)', job.timeEnd)}
  ${field('Contracted Hours', job.contractHours ? job.contractHours + ' hours' : '')}
  ${field('No. of Shoot', job.noOfShoot)}
</div>

${hideMoney ? '' : `<div class="sect">Payment</div>
${feeBlock}
<div class="row cols1">${field('Payment Term', job.paymentTerm)}</div>
<p class="pay"><b>Payment Method:</b> Cash / transfer / Cheque</p>
<p class="pay"><b>Cancellation Fee:</b> ${esc(v.cancellation)}</p>
<p class="pay"><b>Deposit Account:</b> ${esc(v.bank)}<br><b>Account Name:</b> ${esc(v.accountName)}</p>`}

<div class="sect">Acknowledgement Agreement</div>
<div class="ack">${ACK}
  <ol>${TERMS.map(t => `<li>${esc(t)}</li>`).join('')}</ol>
</div>

<div class="sign">
  <div><img class="sig-img" src="${sig}" alt="" onerror="this.style.display='none'">Morgan &amp; Preston Models Bangkok</div>
  <div>Model</div>
  <div>Client</div>
</div>
<p class="foot">MP Models · mpmodelsbkk.com</p>
</body></html>`;
  }

  // Conversion-friendly version for the DRIVE upload only. Google's HTML→Doc
  // converter ignores @media rules and collapses grid/flex (the screen hint
  // leaked into PDFs and the layout squashed) — plain bordered tables convert
  // cleanly and read like the team's old Word-style JOB DETAILS form.
  function buildDrive(job, type) {
    const v = VARIANTS[type] || VARIANTS.tax;
    const pay = calc(job, type);
    const cash = pay.cash, num = pay.num;
    const code = type === 'nontax' ? (job.jobIdNonTax || job.jobId || '') : (job.jobId || job.jobIdNonTax || '');
    const issued = new Date().toISOString().slice(0, 10);
    const multi = Array.isArray(job.modelFees) && job.modelFees.length > 1 ? job.modelFees : null;
    const models = multi ? multi.map(mf => mf.model).filter(Boolean).join(', ')
      : [job.model, job.freelance].filter(Boolean).join(', ');
    const td = 'style="border:1px solid #444;padding:5px 8px;font-size:10.5pt"';
    const lbl = `style="border:1px solid #444;padding:5px 8px;font-size:10.5pt;background:#f2f2f2;width:26%"`;
    const sect = t => `<tr><td colspan="4" style="border:1px solid #444;padding:5px 8px;background:#d9d9d9;font-weight:bold;text-align:center;font-size:11pt">${esc(t)}</td></tr>`;
    const r2 = (a, b) => `<tr><td ${lbl}><b>${esc(a)}</b></td><td colspan="3" ${td}>${esc(b == null ? '' : String(b)) || '-'}</td></tr>`;
    const r4 = (a, b, c, d) => `<tr><td ${lbl}><b>${esc(a)}</b></td><td ${td}>${esc(b || '') || '-'}</td><td ${lbl}><b>${esc(c)}</b></td><td ${td}>${esc(d || '') || '-'}</td></tr>`;
    const shootDates = (job.shootStart || '') + (job.shootEnd && job.shootEnd !== job.shootStart ? ' → ' + job.shootEnd : '');
    const times = (job.timeStart || '') + (job.timeEnd ? ' – ' + job.timeEnd : '');
    let feeRows = '';
    if (multi) {
      feeRows = multi.map(mf => `<tr><td ${lbl}><b>${esc(mf.model || '')}</b></td><td colspan="3" ${td}>${cash(num(mf.fee))}</td></tr>`).join('');
      feeRows += r2('Total Fee' + (v.vat ? ' (Excl. 7% VAT)' : ''), cash(pay.fee));
    } else {
      feeRows = r2('Fee in THB' + (v.vat ? ' (Excluding 7% VAT)' : ''), cash(pay.fee));
    }
    return `<html><body style="font-family:Arial,sans-serif">
<p style="text-align:center;margin:2px 0"><b style="font-size:13pt">${esc(v.company)}</b><br>
<span style="font-size:9.5pt">${esc(v.address)}<br>${v.taxId ? 'Tax ID: ' + esc(v.taxId) + ' · ' : ''}Tel: ${esc(v.tel)}</span></p>
<p style="text-align:center;margin:8px 0"><b style="font-size:14pt">CONFIRMATION</b><br>
<span style="font-size:10pt">Date: ${issued} &nbsp; Job ID: <b>${esc(code) || '-'}</b> &nbsp; Booker: ${esc(job.booker || '-')}</span></p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">
${sect('CLIENT COMPANY DETAILS')}
${r4('Company Name', job.companyName || job.client, 'Tax ID', job.clientTaxId)}
${r2('Company Address', job.companyAddress)}
${r4('Contact Person', job.contactPerson || job.clientName, 'Contact Number', job.contactNumber || job.phone)}
${r2('Email', job.clientEmail || job.email)}
${sect('JOB DETAILS')}
${r2('Assignment Title', job.jobTitle)}
${r4('Product', job.product, 'Role', job.role)}
${r2('Model Name and Surname', models)}
${r4('Media Usage', job.mediaUsage, 'Period of Usage', job.periodOfUsage)}
${r4('Country/ies of Use', job.countryOfUse, 'Shooting Location', job.shootLocation)}
${r4('Date of Shoot', shootDates, 'Time of Shoot', times)}
${r4('Contracted Hours', job.contractHours ? job.contractHours + ' hours' : '', 'No. of Shoot', job.noOfShoot)}
${sect('PAYMENT')}
${feeRows}
${r2('Overtime Fee', pay.otDisplay || '-')}
${v.vat ? r4('Subtotal', cash(pay.subtotal), 'VAT 7%', cash(pay.vat)) : ''}
${r2('TOTAL PAYMENT AMOUNT' + (v.vat ? ' (Incl. 7% VAT)' : ''), cash(pay.total))}
${pay.whtOn ? r4('Less Withholding Tax 3%', '- ' + cash(pay.wht), 'NET AMOUNT TO TRANSFER', cash(pay.netPay)) : ''}
${r4('Payment Term', job.paymentTerm, 'Payment Method', 'Cash / transfer / Cheque')}
${r2('Cancellation Fee', v.cancellation)}
${r2('Deposit Account', v.bank + ' — ' + v.accountName)}
${job.remark ? r2('Remark', job.remark) : ''}
</table>
<p style="font-size:9pt;margin-top:10px"><b>Acknowledgement Agreement</b> — ${esc(ACK)}</p>
<ol style="font-size:8.5pt;margin:4px 0 14px 18px">${TERMS.map(t => `<li>${esc(t)}</li>`).join('')}</ol>
<table cellspacing="0" cellpadding="0" style="width:100%;margin-top:26px;font-size:9.5pt;text-align:center">
<tr><td style="width:33%">______________________<br>Morgan &amp; Preston Models Bangkok</td>
<td style="width:33%">______________________<br>Model</td>
<td style="width:33%">______________________<br>Client</td></tr>
</table>
<p style="text-align:center;font-size:8.5pt;color:#777">MP Models · mpmodelsbkk.com</p>
</body></html>`;
  }

  // The Google-Sheet version of the confirmation as a generic cell grid — the
  // Apps Script renders it 1:1 (values, merges, colors, borders), so the Sheet
  // looks like the FORM (Lisa: not a plain list) and future layout changes
  // never require touching the script again.
  function sheetGrid(job, type) {
    const v = VARIANTS[type] || VARIANTS.tax;
    const pay = calc(job, type);
    const cash = pay.cash, num = pay.num;
    const code = type === 'nontax' ? (job.jobIdNonTax || job.jobId || '') : (job.jobId || job.jobIdNonTax || '');
    const multi = Array.isArray(job.modelFees) && job.modelFees.length > 1 ? job.modelFees : null;
    const models = multi ? multi.map(mf => mf.model).filter(Boolean).join(', ')
      : [job.model, job.freelance].filter(Boolean).join(', ');
    const issued = new Date().toISOString().slice(0, 10);
    const cells = []; let r = 1;
    const add = c => cells.push(c);
    const sect = t => { add({ r, c: 1, v: t, cs: 4, b: 1, bg: '#1a1a1a', fc: '#ffffff', fs: 10 }); r++; };
    const lbl = { bg: '#f3f3f3', b: 1, fs: 9 };
    const row4 = (a, va, b2, vb) => { add({ r, c: 1, v: a, ...lbl }); add({ r, c: 2, v: va, fs: 10 }); add({ r, c: 3, v: b2, ...lbl }); add({ r, c: 4, v: vb, fs: 10 }); r++; };
    const row2 = (a, va, opts) => { add({ r, c: 1, v: a, ...lbl }); add({ r, c: 2, v: va, cs: 3, fs: 10, wrap: 1, ...(opts || {}) }); r++; };
    add({ r, c: 1, v: v.company, cs: 4, b: 1, fs: 12, ha: 'center' }); r++;
    add({ r, c: 1, v: v.address, cs: 4, fs: 9, ha: 'center' }); r++;
    add({ r, c: 1, v: (v.taxId ? 'Tax ID: ' + v.taxId + '  ·  ' : '') + 'Tel: ' + v.tel, cs: 4, fs: 9, ha: 'center' }); r++;
    r++;
    add({ r, c: 1, v: 'CONFIRMATION', cs: 4, b: 1, fs: 14, ha: 'center' }); r++;
    add({ r, c: 1, v: 'Date: ' + issued + '    Job ID: ' + (code || '-') + '    Booker: ' + (job.booker || '-'), cs: 4, fs: 10, ha: 'center' }); r++;
    sect('CLIENT COMPANY DETAILS');
    row4('Company Name', job.companyName || job.client || '', 'Tax ID', job.clientTaxId || '');
    row2('Company Address', job.companyAddress || '');
    row4('Contact Person', job.contactPerson || job.clientName || '', 'Contact Number', job.contactNumber || job.phone || '');
    row2('Email', job.clientEmail || job.email || '');
    sect('JOB DETAILS');
    row2('Assignment Title', job.jobTitle || '');
    row4('Product', job.product || '', 'Role', job.role || '');
    row2('Model Name and Surname', models);
    row4('Media Usage', job.mediaUsage || '', 'Period of Usage', job.periodOfUsage || '');
    row4('Country/ies of Use', job.countryOfUse || '', 'Shooting Location', job.shootLocation || '');
    row4('Date of Shoot', (job.shootStart || '') + (job.shootEnd && job.shootEnd !== job.shootStart ? ' → ' + job.shootEnd : ''),
         'Time of Shoot', (job.timeStart || '') + (job.timeEnd ? ' – ' + job.timeEnd : ''));
    row4('Contracted Hours', job.contractHours ? job.contractHours + ' hours' : '', 'No. of Shoot', job.noOfShoot || '');
    sect('PAYMENT');
    if (multi) {
      add({ r, c: 1, v: 'Model', ...lbl }); add({ r, c: 2, v: 'Fee' + (v.vat ? ' (excl. VAT)' : ''), ...lbl });
      add({ r, c: 3, v: v.vat ? 'VAT 7%' : '', ...lbl }); add({ r, c: 4, v: 'Total', ...lbl }); r++;
      multi.forEach(mf => {
        const f = num(mf.fee), mv = v.vat ? f * 0.07 : 0;
        add({ r, c: 1, v: mf.model || '', fs: 10 }); add({ r, c: 2, v: cash(f), fs: 10 });
        add({ r, c: 3, v: v.vat ? cash(mv) : '', fs: 10 }); add({ r, c: 4, v: cash(f + mv), b: 1, fs: 10 }); r++;
      });
    }
    row4('Fee' + (v.vat ? ' (Excl. 7% VAT)' : ''), cash(pay.fee), 'Overtime Fee', pay.otDisplay || '-');
    if (v.vat) row4('Subtotal', cash(pay.subtotal), 'VAT 7%', cash(pay.vat));
    row2('TOTAL PAYMENT AMOUNT' + (v.vat ? ' (Incl. 7% VAT)' : ''), cash(pay.total), { b: 1, fs: 11, wrap: 0 });
    if (pay.whtOn) row4('Less Withholding Tax 3%', '- ' + cash(pay.wht), 'NET AMOUNT TO TRANSFER', cash(pay.netPay));
    row4('Payment Term', job.paymentTerm || '', 'Payment Method', 'Cash / transfer / Cheque');
    row2('Cancellation Fee', v.cancellation);
    row2('Deposit Account', v.bank + ' — Account Name: ' + v.accountName);
    if (job.remark) row2('Remark', job.remark);
    sect('ACKNOWLEDGEMENT AGREEMENT');
    add({ r, c: 1, v: ACK, cs: 4, fs: 9, wrap: 1 }); r++;
    TERMS.forEach((t, i) => { add({ r, c: 1, v: (i + 1) + '. ' + t, cs: 4, fs: 8, fc: '#b00000', wrap: 1 }); r++; });
    r++;
    add({ r, c: 1, v: 'Morgan & Preston Models Bangkok', b: 1, fs: 9, ha: 'center' });
    add({ r, c: 3, v: 'Model', b: 1, fs: 9, ha: 'center' });
    add({ r, c: 4, v: 'Client', b: 1, fs: 9, ha: 'center' }); r++;
    return { cols: [170, 250, 150, 250], rows: r - 1, cells };
  }

  window.MPConfirmation = {
    defaultType,
    calc,
    sheetGrid,
    // Render the confirmation HTML without opening a window (silent Drive save).
    render(job, type, opts) { return build(job, type || defaultType(job), opts || {}); },
    // Table-based version for the Drive upload (converts cleanly to Doc/PDF).
    renderDrive(job, type) { return buildDrive(job, type || defaultType(job)); },
    lastTitle() { return build.lastTitle; },
    types: [
      { key: 'tax', label: 'Tax Invoice' },
      { key: 'nontax', label: 'Non-Tax' },
      { key: 'intl', label: 'International' },
    ],
    open(job, type, opts) {
      const html = build(job, type || defaultType(job), opts || {});
      const w = window.open('', '_blank');
      if (!w) { alert('Please allow pop-ups to open the confirmation.'); return null; }
      w.document.write(html);
      w.document.close();
      // Hand back the rendered document so the caller can save it as a Word
      // file or push it to the Google Drive folder for Admin.
      return { html, title: build.lastTitle, win: w };
    },
    // A ready-made example (with a SAMPLE watermark) so bookers can see the form's
    // layout without filling in a real job. Touches no data.
    sample(type) {
      this.open(SAMPLE_JOB, type || 'tax', { sample: true });
    },
  };
})();
