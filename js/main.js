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
  searchTerm: '',
  sortOrder: 'default',
};

/* ── Render grid ────────────────────────────────────────── */
function filterModels() {
  const filtered = models.filter(m => {
    if (state.gender.size && !state.gender.has(m.gender)) return false;
    if (state.details.size && !m.details.some(d => state.details.has(d))) return false;
    if (state.availability.size && !state.availability.has(m.availability)) return false;
    if (state.location.size && !state.location.has(m.location)) return false;
    if (state.hairColor.size && !state.hairColor.has(m.hairColor)) return false;
    if (state.eyeColor.size && !state.eyeColor.has(m.eyeColor)) return false;
    if (m.height < state.heightMin || m.height > state.heightMax) return false;
    if (state.searchTerm && !m.name.toLowerCase().includes(state.searchTerm)) return false;
    return true;
  });
  return filtered.sort((a, b) => {
    if (state.sortOrder === 'available') return (a.availability === 'Available Now' ? -1 : 1);
    if (state.sortOrder === 'height-asc') return a.height - b.height;
    if (state.sortOrder === 'height-desc') return b.height - a.height;
    return 0;
  });
}

function renderCard(m) {
  return `
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
  `;
}

function renderGrid() {
  const countEl = document.getElementById('models-count');
  const filtered = filterModels();

  if (countEl) countEl.innerHTML = `Showing <strong>${filtered.length}</strong> of <strong>${models.length}</strong> models`;

  // Split gender mode (models.html)
  const gridFemale = document.getElementById('models-grid-female');
  const gridMale = document.getElementById('models-grid-male');
  if (gridFemale && gridMale) {
    const females = filtered.filter(m => m.gender === 'Female');
    const males = filtered.filter(m => m.gender !== 'Female');
    const sectionFemale = document.getElementById('section-female');
    const sectionMale = document.getElementById('section-male');
    if (sectionFemale) sectionFemale.style.display = females.length ? '' : 'none';
    if (sectionMale) sectionMale.style.display = males.length ? '' : 'none';
    gridFemale.innerHTML = females.length ? females.map(renderCard).join('') : '';
    gridMale.innerHTML = males.length ? males.map(renderCard).join('') : '';
    return;
  }

  // Single grid mode (available.html)
  const grid = document.getElementById('models-grid');
  if (!grid) return;
  if (filtered.length === 0) {
    grid.innerHTML = '<div class="no-results">No models match your filters. <button onclick="resetFilters()">Reset filters</button></div>';
    return;
  }
  grid.innerHTML = filtered.map(renderCard).join('');
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

/* ── Search + Sort ──────────────────────────────────────── */
function initSearchSort() {
  const searchInput = document.getElementById('model-search');
  const sortSelect = document.getElementById('model-sort');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.searchTerm = searchInput.value.trim().toLowerCase();
      renderGrid();
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      state.sortOrder = sortSelect.value;
      renderGrid();
    });
  }
}

/* ── Skeleton loader ────────────────────────────────────── */
function showSkeleton(count) {
  const skeletonHtml = Array(count || 12).fill(
    '<div class="model-card skeleton">' +
    '<div class="model-card-img skeleton-img"></div>' +
    '<div class="model-card-footer">' +
    '<div class="skeleton-line skeleton-line--name"></div>' +
    '<div class="skeleton-line skeleton-line--meta"></div>' +
    '</div></div>'
  ).join('');
  const gridFemale = document.getElementById('models-grid-female');
  const gridMale = document.getElementById('models-grid-male');
  if (gridFemale) { gridFemale.innerHTML = skeletonHtml; return; }
  const grid = document.getElementById('models-grid');
  if (!grid) return;
  grid.innerHTML = Array(count || 12).fill(
    '<div class="model-card skeleton">' +
    '<div class="model-card-img skeleton-img"></div>' +
    '<div class="model-card-footer">' +
    '<div class="skeleton-line skeleton-line--name"></div>' +
    '<div class="skeleton-line skeleton-line--meta"></div>' +
    '</div></div>'
  ).join('');
}

/* ── Reset ──────────────────────────────────────────────── */
function resetFilters() {
  ['gender','details','availability','location','hairColor','eyeColor'].forEach(k => state[k].clear());
  state.heightMin = 0;
  state.heightMax = 999;
  state.searchTerm = '';
  state.sortOrder = 'default';

  document.querySelectorAll('.filter-option input[type="checkbox"]').forEach(cb => cb.checked = false);
  const minInput = document.getElementById('height-min');
  const maxInput = document.getElementById('height-max');
  if (minInput) minInput.value = '';
  if (maxInput) maxInput.value = '';
  const searchInput = document.getElementById('model-search');
  if (searchInput) searchInput.value = '';
  const sortSelect = document.getElementById('model-sort');
  if (sortSelect) sortSelect.value = 'default';

  // Re-apply preset if on available page
  if (window._presetAvailability) state.availability.add(window._presetAvailability);

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
  // Apply preset availability filter (e.g. on available.html)
  if (window._presetAvailability) state.availability.add(window._presetAvailability);

  buildFilters();
  initHeightFilter();
  initCollapsible();
  initSidebarToggle();
  initMobileNav();
  initScrollTop();
  initSearchSort();
  showSkeleton(12);
  requestAnimationFrame(renderGrid);
});
