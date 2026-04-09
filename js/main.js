/* ── Filters state ──────────────────────────────────────── */
const state = {
  gender: new Set(),
  details: new Set(),
  availability: new Set(),
  location: new Set(),
  hairColor: new Set(),
  eyeColor: new Set(),
  heightMin: 0,
  heightMax: 999,
};

/* ── Render grid ────────────────────────────────────────── */
function filterModels() {
  return models.filter(m => {
    if (state.gender.size && !state.gender.has(m.gender)) return false;
    if (state.details.size && !m.details.some(d => state.details.has(d))) return false;
    if (state.availability.size && !state.availability.has(m.availability)) return false;
    if (state.location.size && !state.location.has(m.location)) return false;
    if (state.hairColor.size && !state.hairColor.has(m.hairColor)) return false;
    if (state.eyeColor.size && !state.eyeColor.has(m.eyeColor)) return false;
    if (m.height < state.heightMin || m.height > state.heightMax) return false;
    return true;
  });
}

function renderGrid() {
  const grid = document.getElementById('models-grid');
  const countEl = document.getElementById('models-count');
  const filtered = filterModels();

  countEl.innerHTML = `Showing <strong>${filtered.length}</strong> of <strong>${models.length}</strong> models`;

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="no-results">No models match your filters. <button onclick="resetFilters()">Reset filters</button></div>';
    return;
  }

  grid.innerHTML = filtered.map(m => `
    <a class="model-card" href="model.html?slug=${m.slug}" title="${m.name}">
      <div class="model-card-img">
        <img src="${m.img}" alt="${m.name}" loading="lazy">
        <div class="model-card-overlay">
          <div class="model-card-overlay-info">
            <div>${m.details.join(' · ')}</div>
            <div class="height">${m.height} cm · ${m.location}</div>
          </div>
        </div>
        ${m.availability === 'Available Now' ? '<span class="model-card-tag">Available</span>' : ''}
      </div>
      <div class="model-card-footer">
        <div class="model-card-name">${m.name}</div>
        <div class="model-card-meta">${m.gender} · ${m.height} cm</div>
      </div>
    </a>
  `).join('');
}

/* ── Build filter sidebar ───────────────────────────────── */
function buildCheckboxGroup(containerId, stateKey, options) {
  const container = document.getElementById(containerId);
  if (!container) return;

  options.forEach(({ value, label, count }) => {
    const id = `filter-${stateKey}-${value.replace(/\s+/g, '-').toLowerCase()}`;
    const div = document.createElement('label');
    div.className = 'filter-option';
    div.innerHTML = `
      <input type="checkbox" id="${id}" value="${value}">
      ${label || value}
      ${count !== undefined ? `<span class="count">(${count})</span>` : ''}
    `;
    const checkbox = div.querySelector('input');
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state[stateKey].add(value);
      else state[stateKey].delete(value);
      renderGrid();
    });
    container.appendChild(div);
  });
}

function countBy(field) {
  const counts = {};
  models.forEach(m => {
    const val = Array.isArray(m[field]) ? m[field] : [m[field]];
    val.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  });
  return counts;
}

function buildFilters() {
  const genderCounts = countBy('gender');
  buildCheckboxGroup('filter-gender', 'gender', [
    { value: 'Female', count: genderCounts['Female'] || 0 },
    { value: 'Male', count: genderCounts['Male'] || 0 },
    { value: 'Trans Gender', count: genderCounts['Trans Gender'] || 0 },
  ]);

  const detailCounts = countBy('details');
  const allDetails = ['Actor','Albino','Asian','Commercial','Fashion','Plus Size Model','Thai'];
  buildCheckboxGroup('filter-details', 'details',
    allDetails.map(d => ({ value: d, count: detailCounts[d] || 0 }))
  );

  const availCounts = countBy('availability');
  buildCheckboxGroup('filter-availability', 'availability', [
    { value: 'Available Now', count: availCounts['Available Now'] || 0 },
    { value: 'Available on Request', count: availCounts['Available on Request'] || 0 },
  ]);

  const locCounts = countBy('location');
  buildCheckboxGroup('filter-location', 'location', [
    { value: 'Bangkok', count: locCounts['Bangkok'] || 0 },
    { value: 'Chiang Mai', count: locCounts['Chiang Mai'] || 0 },
    { value: 'Koh Samui-Koh Phangan', count: locCounts['Koh Samui-Koh Phangan'] || 0 },
    { value: 'Out of Thailand', count: locCounts['Out of Thailand'] || 0 },
    { value: 'Phuket', count: locCounts['Phuket'] || 0 },
  ]);

  const hairCounts = countBy('hairColor');
  const hairColors = ['Bald','Black','Blonde','Blue','Brown','Dark Blonde','Dark Brown','Ginger','Gray','Green','Light Blonde','Light Brown','Orange','Pink','Purple','Red','Sandy','White','Yellow'];
  buildCheckboxGroup('filter-hair', 'hairColor',
    hairColors.map(h => ({ value: h, count: hairCounts[h] || 0 }))
  );

  const eyeCounts = countBy('eyeColor');
  const eyeColors = ['Black','Blue','Brown','Dark Brown','Gray','Green','Green/Blue','Green/Brown','Green/Yellow','Hazel','Maroon','Multi Colored','Pink','Red'];
  buildCheckboxGroup('filter-eye', 'eyeColor',
    eyeColors.map(e => ({ value: e, count: eyeCounts[e] || 0 }))
  );
}

/* ── Height range ───────────────────────────────────────── */
function initHeightFilter() {
  const minInput = document.getElementById('height-min');
  const maxInput = document.getElementById('height-max');
  if (!minInput || !maxInput) return;

  const update = () => {
    state.heightMin = parseInt(minInput.value) || 0;
    state.heightMax = parseInt(maxInput.value) || 999;
    renderGrid();
  };

  minInput.addEventListener('input', update);
  maxInput.addEventListener('input', update);
}

/* ── Collapsible filter groups ──────────────────────────── */
function initCollapsible() {
  document.querySelectorAll('.filter-group-title').forEach(title => {
    title.addEventListener('click', () => {
      title.closest('.filter-group').classList.toggle('collapsed');
    });
  });
}

/* ── Mobile sidebar toggle ──────────────────────────────── */
function initSidebarToggle() {
  const btn = document.getElementById('sidebar-toggle');
  const inner = document.getElementById('sidebar-inner');
  if (!btn || !inner) return;
  btn.addEventListener('click', () => {
    inner.classList.toggle('collapsed');
    btn.querySelector('.toggle-icon').textContent = inner.classList.contains('collapsed') ? '▾' : '▴';
  });
}

/* ── Mobile nav ─────────────────────────────────────────── */
function initMobileNav() {
  const toggle = document.getElementById('menu-toggle');
  const nav = document.getElementById('site-nav');
  if (!toggle || !nav) return;
  toggle.addEventListener('click', () => nav.classList.toggle('open'));
}

/* ── Reset ──────────────────────────────────────────────── */
function resetFilters() {
  ['gender','details','availability','location','hairColor','eyeColor'].forEach(k => state[k].clear());
  state.heightMin = 0;
  state.heightMax = 999;

  document.querySelectorAll('.filter-option input[type="checkbox"]').forEach(cb => cb.checked = false);
  const minInput = document.getElementById('height-min');
  const maxInput = document.getElementById('height-max');
  if (minInput) minInput.value = '';
  if (maxInput) maxInput.value = '';

  renderGrid();
}

/* ── Scroll to top ──────────────────────────────────────── */
function initScrollTop() {
  const btn = document.getElementById('scroll-top');
  if (!btn) return;
  window.addEventListener('scroll', () => {
    btn.classList.toggle('visible', window.scrollY > 400);
  });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

/* ── Init ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  buildFilters();
  initHeightFilter();
  initCollapsible();
  initSidebarToggle();
  initMobileNav();
  initScrollTop();
  renderGrid();
});
