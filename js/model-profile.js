/* ── Model profile page logic ───────────────────────────── */

function getSlug() {
  const params = new URLSearchParams(window.location.search);
  return params.get('slug');
}

function renderProfile(model) {
  const main = document.getElementById('profile-main');

  // Generate some extra thumbnails from the same model's main image
  // (In a real app these would be the model's gallery images)
  const thumbImgs = [model.img, model.img, model.img, model.img];

  main.innerHTML = `
    <nav class="breadcrumb">
      <a href="index.html">Models</a>
      <span class="sep">›</span>
      <span class="current">${model.name}</span>
    </nav>

    <div class="profile-grid">
      <!-- Gallery -->
      <div class="profile-gallery">
        <img class="profile-hero" id="profile-hero" src="${model.img}" alt="${model.name}">
        <div class="profile-thumbs" id="profile-thumbs">
          ${thumbImgs.map((src, i) => `
            <img class="profile-thumb${i === 0 ? ' active' : ''}"
                 src="${src}" alt="${model.name}" data-src="${src}"
                 onclick="setHero(this)">
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
          <button class="btn-secondary" onclick="openContact()">Comp Card</button>
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
  initScrollTop();
  initMobileNav();
});
