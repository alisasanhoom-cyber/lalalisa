/* ── Model profile page logic ───────────────────────────── */

/* ── Lightbox ───────────────────────────────────────────── */
let lightboxImages = [];
let lightboxIndex = 0;

function openLightbox(index) {
  lightboxIndex = index;
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lb-img');
  if (!lb || !img) return;
  img.src = lightboxImages[lightboxIndex];
  lb.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (lb) lb.classList.remove('open');
  document.body.style.overflow = '';
}

function lightboxNext() {
  lightboxIndex = (lightboxIndex + 1) % lightboxImages.length;
  const img = document.getElementById('lb-img');
  if (img) img.src = lightboxImages[lightboxIndex];
}

function lightboxPrev() {
  lightboxIndex = (lightboxIndex - 1 + lightboxImages.length) % lightboxImages.length;
  const img = document.getElementById('lb-img');
  if (img) img.src = lightboxImages[lightboxIndex];
}

function initLightbox() {
  document.getElementById('lb-close')?.addEventListener('click', closeLightbox);
  document.getElementById('lb-next')?.addEventListener('click', lightboxNext);
  document.getElementById('lb-prev')?.addEventListener('click', lightboxPrev);
  document.getElementById('lightbox')?.addEventListener('click', function(e) {
    if (e.target === this) closeLightbox();
  });
  document.addEventListener('keydown', function(e) {
    const lb = document.getElementById('lightbox');
    if (!lb?.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') lightboxNext();
    if (e.key === 'ArrowLeft') lightboxPrev();
  });
}

/* ── Comp Card ──────────────────────────────────────────── */
let currentModel = null;

function openCompCard() {
  if (!currentModel) return;
  const m = currentModel;
  const modal = document.getElementById('compcard-modal');
  const inner = document.getElementById('compcard-inner');
  if (!modal || !inner) return;
  inner.innerHTML = `
    <div class="compcard-layout">
      <div class="compcard-photo">
        <img src="${m.img}" alt="${m.name}">
      </div>
      <div class="compcard-details">
        <div class="compcard-logo">
          <img src="https://www.mpmodelsbkk.com/wp-content/uploads/2020/04/mpmodel-logo-black-270x56.png"
               alt="Morgan &amp; Preston Models" style="height:32px;width:auto">
        </div>
        <h2 class="compcard-name">${m.name}</h2>
        <p class="compcard-id">ID: MP-${m.slug.toUpperCase().replace(/-/g,'').slice(0,10)}</p>
        <table class="compcard-stats">
          <tr><td>Gender</td><td>${m.gender}</td></tr>
          <tr><td>Height</td><td>${m.height} cm</td></tr>
          <tr><td>Hair</td><td>${m.hairColor}</td></tr>
          <tr><td>Eyes</td><td>${m.eyeColor}</td></tr>
          <tr><td>Location</td><td>${m.location}</td></tr>
          <tr><td>Details</td><td>${m.details.join(', ')}</td></tr>
          <tr><td>Status</td><td>${m.availability}</td></tr>
        </table>
        <div class="compcard-agency">
          <p><strong>Morgan &amp; Preston Models Bangkok</strong></p>
          <p>info@mpmodelsbkk.com · +66 62 445 5897</p>
          <p>249 Sukhumvit 49, Bangkok 10110</p>
        </div>
        <div class="compcard-actions">
          <button class="btn-print" onclick="window.print()">Print Comp Card</button>
          <button class="btn-print" style="background:var(--grey-text)" onclick="closeCompCard()">Close</button>
        </div>
      </div>
    </div>
  `;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCompCard() {
  const modal = document.getElementById('compcard-modal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

function getSlug() {
  const params = new URLSearchParams(window.location.search);
  return params.get('slug');
}

function renderProfile(model) {
  currentModel = model;
  const main = document.getElementById('profile-main');

  // Update og:image meta tag dynamically
  const ogImg = document.getElementById('og-image');
  if (ogImg) ogImg.setAttribute('content', model.img);

  const thumbImgs = [model.img, model.img, model.img, model.img];
  lightboxImages = thumbImgs;

  main.innerHTML = `
    <nav class="breadcrumb">
      <a href="index.html">Models</a>
      <span class="sep">›</span>
      <span class="current">${model.name}</span>
    </nav>

    <div class="profile-grid">
      <!-- Gallery -->
      <div class="profile-gallery">
        <img class="profile-hero" id="profile-hero" src="${model.img}" alt="${model.name}"
             style="cursor:zoom-in" onclick="openLightbox(0)">
        <div class="profile-thumbs" id="profile-thumbs">
          ${thumbImgs.map((src, i) => `
            <img class="profile-thumb${i === 0 ? ' active' : ''}"
                 src="${src}" alt="${model.name}" data-src="${src}"
                 onclick="setHero(this);openLightbox(${i})">
          `).join('')}
        </div>
      </div>

      <!-- Info Panel -->
      <div class="profile-panel">
        <h1 class="profile-name">${model.name}</h1>
        <p class="profile-id">ID : MP-${model.slug.toUpperCase().replace(/-/g,'').slice(0,10)}</p>

        <div class="profile-stats">
          <div class="stat-row">
            <span class="stat-label">Gender</span>
            <span class="stat-value">${model.gender}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Details</span>
            <span class="stat-value">${model.details.map(d => `<span class="stat-tag">${d}</span>`).join('')}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Height</span>
            <span class="stat-value">${model.height} cm</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Hair Color</span>
            <span class="stat-value">${model.hairColor}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Eye Color</span>
            <span class="stat-value">${model.eyeColor}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Location</span>
            <span class="stat-value">${model.location}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Availability</span>
            <span class="stat-value">
              <span class="availability-badge ${model.availability === 'Available Now' ? 'now' : 'request'}">
                ${model.availability}
              </span>
            </span>
          </div>
        </div>

        <div class="profile-actions">
          <button class="btn-primary" onclick="openContact()">Booking</button>
          <button class="btn-secondary" onclick="openCompCard()">Comp Card</button>
        </div>
      </div>
    </div>
  `;

  document.title = `${model.name} | Morgan & Preston Models Bangkok`;
}

function setHero(thumb) {
  const hero = document.getElementById('profile-hero');
  if (hero) hero.src = thumb.dataset.src;
  document.querySelectorAll('.profile-thumb').forEach(t => t.classList.remove('active'));
  thumb.classList.add('active');
}

function renderOtherModels(currentSlug) {
  const others = models.filter(m => m.slug !== currentSlug);
  const shuffled = others.sort(() => Math.random() - 0.5).slice(0, 8);
  const section = document.getElementById('other-models');
  const grid = document.getElementById('other-models-grid');
  if (!section || !grid) return;

  grid.innerHTML = shuffled.map(m => `
    <a class="model-card" href="model.html?slug=${m.slug}">
      <div class="model-card-img">
        <img src="${m.img}" alt="${m.name}" loading="lazy">
      </div>
      <div class="model-card-footer">
        <div class="model-card-name">${m.name}</div>
        <div class="model-card-meta">${m.gender} · ${m.height} cm</div>
      </div>
    </a>
  `).join('');

  section.style.display = 'block';
}

function openContact() {
  window.location.href = 'contact.html';
}

/* ── Init ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const slug = getSlug();
  const main = document.getElementById('profile-main');

  if (!slug) {
    main.innerHTML = `
      <div class="profile-not-found">
        <h2>No model specified</h2>
        <a href="index.html">← Back to Models</a>
      </div>`;
    return;
  }

  const model = models.find(m => m.slug === slug);

  if (!model) {
    main.innerHTML = `
      <div class="profile-not-found">
        <h2>Model not found</h2>
        <p>We couldn't find a model with that name.</p>
        <a href="index.html">← Back to Models</a>
      </div>`;
    return;
  }

  renderProfile(model);
  renderOtherModels(slug);
  initLightbox();
  initScrollTop();
  initMobileNav();
});
