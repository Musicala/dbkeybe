// leads.ui.js - Tabla de contactos con filtros y paginacion real.

import { getState, setState, setFilter, clearFilters, onStateChange } from '../utils/state.js';
import { PAGE_SIZE } from '../utils/constants.js';
import { formatDate, formatRelativeDate, statusBadge, channelBadge, truncate } from '../utils/formatters.js';
import { displayPhone } from '../utils/phone.utils.js';
import { exportLeadsToCSV } from '../services/export.service.js';
import { getLeadById, loadLeadsPage } from '../services/firestore.service.js';
import { showError, showSuccess } from './toast.ui.js';

const getEl = (id) => document.getElementById(id);

let _debounceTimer = null;
let _pageNumber = 1;
let _pageCursors = [null];
let _hasMore = false;
let _loading = false;

export function initLeadsUI() {
  bindFilters();
  bindExportButton();
  bindPagination();
  onStateChange('filters', () => resetAndLoadLeadsPage());
}

function bindFilters() {
  const search = getEl('filter-search');
  const status = getEl('filter-status');
  const assigned = getEl('filter-assigned');
  const channel = getEl('filter-channel');
  const interest = getEl('filter-interest');
  const btnClear = getEl('btn-clear-filters');

  search?.addEventListener('input', (e) => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => setFilter({ search: e.target.value.trim() }), 300);
  });

  status?.addEventListener('change', (e) => setFilter({ status: e.target.value }));
  assigned?.addEventListener('change', (e) => setFilter({ assigned: e.target.value }));
  channel?.addEventListener('change', (e) => setFilter({ channel: e.target.value }));
  interest?.addEventListener('change', (e) => setFilter({ interest: e.target.value }));

  btnClear?.addEventListener('click', () => {
    clearFilters();
    resetFilterInputs();
  });
}

function resetFilterInputs() {
  ['filter-search', 'filter-status', 'filter-assigned', 'filter-channel', 'filter-interest'].forEach((id) => {
    const el = getEl(id);
    if (el) el.value = '';
  });
}

export function applyFiltersAndRender() {
  return loadCurrentLeadsPage();
}

async function resetAndLoadLeadsPage() {
  _pageNumber = 1;
  _pageCursors = [null];
  await loadCurrentLeadsPage();
}

async function loadCurrentLeadsPage() {
  if (_loading) return;
  _loading = true;
  renderLoading();

  try {
    const filters = getState('filters') || {};
    const result = await loadLeadsPage({
      pageSize: PAGE_SIZE,
      cursor: _pageCursors[_pageNumber - 1] || null,
      ...filters,
    });
    _hasMore = result.hasMore;
    _pageCursors[_pageNumber] = result.cursor;
    setState({ currentPageLeads: result.leads, filteredLeads: result.leads, currentPage: _pageNumber });
    // Limpiar la bandera ANTES de pintar: si no, renderPagination dibuja los botones
    // con _loading=true y quedan deshabilitados para siempre (no se vuelve a repintar).
    _loading = false;
    renderLeadsTable(result.leads);
    renderPagination(result.leads.length);
    updateLeadsSubtitle(result.leads.length, filters);
  } catch (err) {
    console.error('Error cargando pagina de leads:', err);
    showError('No se pudo cargar la pagina de contactos: ' + err.message);
    renderLeadsTable([]);
  } finally {
    _loading = false;
  }
}

function renderLoading() {
  const tbody = getEl('leads-tbody');
  if (!tbody) return;
  tbody.innerHTML = `
    <tr>
      <td colspan="9" class="table-empty">
        <div class="empty-state-inner">
          <p>Cargando contactos...</p>
        </div>
      </td>
    </tr>`;
}

function renderLeadsTable(leads) {
  const tbody = getEl('leads-tbody');
  if (!tbody) return;

  if (!leads.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="table-empty">
          <div class="empty-state-inner">
            <span class="empty-icon">♪</span>
            <p>No se encontraron contactos con los filtros aplicados.</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = leads.map((lead) => `
    <tr>
      <td>
        <span class="contact-name">${escHtml(lead.fullName || '(Sin nombre)')}</span>
        ${lead.isDuplicate || lead.revisionStatus === 'duplicado'
          ? `<span class="contact-email">Duplicado consolidado: ${escHtml(lead.duplicateCount || lead.duplicateRowsSummary?.totalRows || 2)} filas</span>`
          : ''}
        ${lead.email ? `<span class="contact-email">${escHtml(lead.email)}</span>` : ''}
      </td>
      <td>${escHtml(displayPhone(lead.phone))}</td>
      <td>${channelBadge(lead.channel)}</td>
      <td title="${escHtml(lead.lastMessage || '')}">
        <span style="font-size:12px;">${escHtml(truncate(lead.lastMessage, 45))}</span>
        ${lead.lastMessageAt ? `<br/><span style="font-size:11px;color:var(--c-text-soft);">${formatRelativeDate(lead.lastMessageAt)}</span>` : ''}
      </td>
      <td><span class="badge badge--interest" style="font-size:11px;">${escHtml(lead.possibleInterest || 'Sin clasificar')}</span></td>
      <td>${statusBadge(lead.revisionStatus || 'pendiente_revision')}</td>
      <td style="font-size:13px;">${escHtml(lead.assignedTo || 'Sin asignar')}</td>
      <td style="font-size:11px;color:var(--c-text-soft);">${lead.updatedAt ? formatDate(lead.updatedAt) : '-'}</td>
      <td class="col-actions"><button class="btn-open-lead" data-lead-id="${escHtml(lead.id)}">Ver</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-open-lead').forEach((btn) => {
    btn.addEventListener('click', () => openLeadDetail(btn.dataset.leadId));
  });
}

function renderPagination(count) {
  const infoEl = getEl('pagination-info');
  const btnPrev = getEl('btn-prev-page');
  const btnNext = getEl('btn-next-page');

  if (infoEl) {
    const start = count === 0 ? 0 : (_pageNumber - 1) * PAGE_SIZE + 1;
    const end = count === 0 ? 0 : start + count - 1;
    infoEl.textContent = count > 0 ? `${start}-${end}${_hasMore ? '+' : ''}` : '0 resultados';
  }

  if (btnPrev) btnPrev.disabled = _pageNumber <= 1 || _loading;
  if (btnNext) btnNext.disabled = !_hasMore || _loading;
}

function bindPagination() {
  getEl('btn-prev-page')?.addEventListener('click', async () => {
    if (_pageNumber <= 1) return;
    _pageNumber--;
    await loadCurrentLeadsPage();
  });

  getEl('btn-next-page')?.addEventListener('click', async () => {
    if (!_hasMore) return;
    _pageNumber++;
    await loadCurrentLeadsPage();
  });
}

function bindExportButton() {
  getEl('btn-export-csv')?.addEventListener('click', () => {
    const current = getState('currentPageLeads') || [];
    try {
      exportLeadsToCSV(current);
      showSuccess(`CSV exportado con ${current.length} contactos de la pagina actual.`);
    } catch (err) {
      showError(err.message);
    }
  });
}

function updateLeadsSubtitle(count, filters) {
  const el = getEl('leads-subtitle');
  if (!el) return;
  const hasFilter = Object.values(filters || {}).some(Boolean);
  el.textContent = hasFilter
    ? `${count} contactos en esta pagina filtrada`
    : `${count} contactos en esta pagina`;
}

async function openLeadDetail(leadId) {
  const pageLeads = getState('currentPageLeads') || [];
  let lead = pageLeads.find((l) => l.id === leadId);
  if (!lead) lead = await getLeadById(leadId);
  if (!lead) return;

  setState({ currentLead: lead });
  document.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'lead-detail' } }));
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
