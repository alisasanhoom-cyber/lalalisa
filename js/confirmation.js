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
      accountName: 'Alessandro Scalia',
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

  function build(job, type) {
    const v = VARIANTS[type] || VARIANTS.tax;
    const code = type === 'nontax'
      ? (job.jobIdNonTax || job.jobId || '')
      : (job.jobId || job.jobIdNonTax || '');
    const issued = new Date().toISOString().slice(0, 10);
    const models = [job.model, job.freelance].filter(Boolean).join(', ');
    // Robust number parse — the fee comes in as "15,000" (with commas), which
    // Number() would turn into NaN. Strip anything that isn't a digit or dot.
    const num = x => { const n = parseFloat(String(x == null ? '' : x).replace(/[^\d.]/g, '')); return isNaN(n) ? 0 : n; };
    const fee = num(job.budget);
    const otIsNumber = /^[\d,]+(\.\d+)?$/.test(String(job.overtimeFee || '').trim());
    const ot = otIsNumber ? num(job.overtimeFee) : 0;      // only add overtime to the total if it's a number
    const subtotal = fee + ot;                             // fee + overtime, before VAT
    const vat = v.vat ? subtotal * 0.07 : 0;
    const total = subtotal + vat;                          // grand total the client pays
    const logo = location.origin + '/images/mp-logo.png';
    // Money in the job's currency (THB ฿ / USD $ / CNY ¥).
    const sym = { THB: '฿', USD: '$', CNY: '¥' }[job.currency] || '฿';
    const cash = n => sym + Math.round(Number(n || 0)).toLocaleString('en-US');
    const otDisplay = otIsNumber ? cash(ot) : (job.overtimeFee || '');

    const feeBlock = v.vat ? `
      <div class="row cols4">
        ${field('Fee (Excluding 7% VAT)', fee ? cash(fee) : '')}
        ${field('Overtime Fee', otDisplay)}
        ${field('Subtotal', subtotal ? cash(subtotal) : '')}
        ${field('VAT 7%', subtotal ? cash(vat) : '')}
      </div>
      <div class="row cols1 total-row">
        ${field('Total Payment Amount (incl. 7% VAT)', total ? cash(total) : '')}
      </div>`
      : `
      <div class="row cols2">
        ${field('Fee', fee ? cash(fee) : '')}
        ${field('Overtime Fee', otDisplay)}
      </div>
      <div class="row cols1 total-row">
        ${field('Total Payment Amount', total ? cash(total) : '')}
      </div>`;

    return `<!doctype html><html><head><meta charset="utf-8">
<title>Job Confirmation ${esc(code)}</title>
<style>
  *{box-sizing:border-box}
  @page{size:A4;margin:9mm}
  html,body{margin:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;font-size:9.6px;line-height:1.28}
  @media screen{body{padding:22px 28px;max-width:820px;margin:0 auto}}
  .print-btn{position:fixed;top:12px;right:12px;background:#1b998b;color:#fff;border:none;padding:8px 15px;border-radius:8px;font-size:13px;cursor:pointer;z-index:5}
  .hint{position:fixed;top:12px;left:12px;background:#fff8e6;border:1px solid #f0dcb0;color:#8a5a12;padding:6px 11px;border-radius:7px;font-size:11px;max-width:300px}
  .type-tag{display:inline-block;background:#eee;color:#555;padding:2px 8px;border-radius:5px;font-size:9px;margin-left:8px}
  @media print{.print-btn,.hint,.type-tag{display:none}}
  .head{display:flex;align-items:flex-start;gap:12px;border-bottom:2px solid #1b998b;padding-bottom:8px}
  .head img{height:38px}
  .co b{font-size:12px} .co{font-size:9px;color:#444;line-height:1.45}
  .title{text-align:center;font-size:15px;letter-spacing:.12em;font-weight:700;margin:8px 0 1px}
  .topmeta{display:flex;justify-content:flex-end;gap:22px;font-size:9.6px;margin-bottom:7px}
  .topmeta b{color:#1b998b}
  .sect{background:#1a1a1a;color:#fff;font-size:9px;letter-spacing:.05em;font-weight:700;padding:3px 7px;margin:8px 0 5px;text-transform:uppercase}
  .row{display:grid;gap:5px 12px;margin-bottom:5px}
  .cols1{grid-template-columns:1fr} .cols2{grid-template-columns:1fr 1fr}
  .cols3{grid-template-columns:1fr 1fr 1fr} .cols4{grid-template-columns:1fr 1fr 1fr 1fr}
  .f{display:flex;flex-direction:column;min-width:0}
  .fl{font-size:7.5px;text-transform:uppercase;letter-spacing:.02em;color:#888;margin-bottom:1px}
  .fv{border-bottom:1px solid #cfcfcf;padding:1px 0 2px;min-height:13px;font-weight:600;white-space:pre-wrap;word-break:break-word}
  .total-row .f{background:#f4f3ee;border:1px solid #cfcfcf;border-radius:5px;padding:5px 10px}
  .total-row .fl{color:#333}
  .total-row .fv{border-bottom:none;font-size:14px;font-weight:800;padding:0}
  .pay{font-size:8.8px;margin:2px 0} .pay b{color:#1a1a1a}
  .ack{font-size:7.4px;color:#444;line-height:1.32;margin-top:6px}
  .ack ol{padding-left:14px;margin:3px 0} .ack li{margin-bottom:2px}
  .sign{display:flex;gap:26px;margin-top:20px}
  .sign div{flex:1;border-top:1px solid #999;padding-top:5px;text-align:center;font-size:9px;color:#555}
  .foot{margin-top:10px;font-size:8px;color:#aaa;text-align:center}
</style></head><body>
<button class="print-btn" onclick="window.print()">Print / Save PDF</button>
<div class="hint">To get a clean PDF: in the print box open <b>More settings</b> and turn <b>OFF “Headers and footers”</b> (removes the date &amp; link). Chrome remembers it.</div>

<div class="head">
  <img src="${logo}" alt="MP" onerror="this.style.display='none'">
  <div class="co">
    <b>${esc(v.company)}</b><br>
    ${esc(v.address)}<br>
    ${v.taxId ? 'Tax ID: ' + esc(v.taxId) + ' &nbsp;·&nbsp; ' : ''}Tel: ${esc(v.tel)}
  </div>
</div>

<div class="title">CONFIRMATION<span class="type-tag">${esc(v.title)}</span></div>
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
<div class="row cols2">
  ${field('Contact Person', job.contactPerson || job.clientName)}
  ${v.contactNumber ? field('Contact Number', job.contactNumber || job.phone) : field('Email', job.clientEmail || job.email)}
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
<div class="row cols3">
  ${field('Time of Shoot (Start)', job.timeStart)}
  ${field('Time of Shoot (End)', job.timeEnd)}
  ${field('No. of Shoot', job.noOfShoot)}
</div>

<div class="sect">Payment</div>
${feeBlock}
<div class="row cols1">${field('Payment Term', job.paymentTerm)}</div>
<p class="pay"><b>Payment Method:</b> Cash / transfer / Cheque</p>
<p class="pay"><b>Cancellation Fee:</b> ${esc(v.cancellation)}</p>
<p class="pay"><b>Deposit Account:</b> ${esc(v.bank)}<br><b>Account Name:</b> ${esc(v.accountName)}</p>

<div class="sect">Acknowledgement Agreement</div>
<div class="ack">${ACK}
  <ol>${TERMS.map(t => `<li>${esc(t)}</li>`).join('')}</ol>
</div>

<div class="sign">
  <div>Morgan &amp; Preston Models Bangkok</div>
  <div>Model</div>
  <div>Client</div>
</div>
<p class="foot">Morgan &amp; Preston Models Bangkok · mpmodelsbkk.com</p>
</body></html>`;
  }

  window.MPConfirmation = {
    defaultType,
    types: [
      { key: 'tax', label: 'Tax Invoice' },
      { key: 'nontax', label: 'Non-Tax' },
      { key: 'intl', label: 'International' },
    ],
    open(job, type) {
      const w = window.open('', '_blank');
      if (!w) { alert('Please allow pop-ups to open the confirmation.'); return; }
      w.document.write(build(job, type || defaultType(job)));
      w.document.close();
    },
  };
})();
