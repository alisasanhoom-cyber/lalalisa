/* ===================================================================
   CLIENT BOOKING FORM  (runs on book.html)
   -------------------------------------------------------------------
   In plain English:
     1. If the page was opened for a specific model (book.html?slug=zach),
        show that model at the top. Otherwise show a dropdown to pick one.
     2. When the client submits the form, send it to the server
        (POST /api/bookings).
     3. On success, hide the form and show a "Request received" message.
   =================================================================== */
(function () {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('slug');

  const card = document.getElementById('book-model-card');
  const pickerGroup = document.getElementById('model-picker-group');
  const picker = document.getElementById('f-modelPicker');
  const slugField = document.getElementById('f-modelSlug');
  const nameField = document.getElementById('f-modelName');

  function selectModel(m) {
    slugField.value = m.slug;
    nameField.value = m.name;
    document.getElementById('bm-img').src = m.img;
    document.getElementById('bm-name').textContent = m.name;
    document.getElementById('bm-meta').textContent =
      `${m.gender} · ${m.height} cm · ${m.location} · ${m.availability}`;
    card.style.display = 'flex';
  }

  const preselected = slug && models.find(m => m.slug === slug);

  if (preselected) {
    selectModel(preselected);
  } else {
    // Show picker with all models
    pickerGroup.style.display = 'block';
    picker.required = true;
    models
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.slug;
        opt.textContent = `${m.name} — ${m.gender}, ${m.location}`;
        picker.appendChild(opt);
      });
    picker.addEventListener('change', () => {
      const m = models.find(x => x.slug === picker.value);
      if (m) selectModel(m);
    });
  }

  // Prevent end date before start date
  const startEl = document.getElementById('f-startDate');
  const endEl = document.getElementById('f-endDate');
  startEl.addEventListener('change', () => { endEl.min = startEl.value; });

  const form = document.getElementById('book-form');
  const errorEl = document.getElementById('book-error');
  const submitBtn = document.getElementById('book-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';

    if (!slugField.value) {
      errorEl.textContent = 'Please choose a model.';
      errorEl.style.display = 'block';
      return;
    }

    const payload = {
      modelSlug: slugField.value,
      modelName: nameField.value,
      clientName: document.getElementById('f-clientName').value,
      company: document.getElementById('f-company').value,
      email: document.getElementById('f-email').value,
      phone: document.getElementById('f-phone').value,
      projectType: document.getElementById('f-projectType').value,
      startDate: document.getElementById('f-startDate').value,
      endDate: document.getElementById('f-endDate').value,
      budget: document.getElementById('f-budget').value,
      notes: document.getElementById('f-notes').value,
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');

      document.getElementById('success-name').textContent = payload.clientName;
      document.getElementById('success-model').textContent = payload.modelName || 'your selected model';
      form.style.display = 'none';
      card.style.display = 'none';
      document.getElementById('book-success').style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Booking Request';
    }
  });
})();
