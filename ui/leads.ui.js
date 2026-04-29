// ─────────────────────────────────────────────────────────
// leads.ui.js — Tabla de contactos con filtros y paginación
// ─────────────────────────────────────────────────────────

import { getState, setState, setFilter, clearFilters, onStateChange } from '../utils/state.js';
import { PAGE_SIZE } from '../utils/constants.js';
import {
  formatDate, formatRelativeDate, statusBadge, channelBadge,
  truncate, formatName,
} from '../utils/formatters.js';
import { displayPhone }    from '../utils/phone.utils.js';
import { exportLeadsToCSV } from '../services/export.service.js';
import { showError, showSuccess } from './toast.ui.js';

const getEl = (id) => document.getElementById(id);

let _debounceTimer = null;

// ── Inicialización ────────────────────────────────────────

export function initLeadsUI() {
  bindFilters();
  bindExportButton();
  bindPagination();

  // Re-renderizar cuando cambia allLeads o filtros
  onStateChange('allLeads', () => applyFiltersAndRender());
  onStateChange('filters',  () => applyFiltersAndRender());
  onStateChange('currentPage', () => renderCurrentPage());
}

// ── Filtros ───────────────────────────────────────────────

function bindFilters() {
  const search   = getEl('filter-search');
  const status   = getEl('filter-status');
  const assigned = getEl('filter-assigned');
  const channel  = getEl('filter-channel');
  const interest = getEl('filter-interest');
  const btnClear = getEl('btn-clear-filters');

  search?.addEventListener('input', (e) => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      setFilter({ search: e.target.value.trim() });
    }, 300);
  });

  status?.addEventListener('change',   (e) => setFilter({ status:   e.target.value }));
  assigned?.addEventListener('change', (e) => setFilter({ assigned: e.target.value }));
  channel?.addEventListener('change',  (e) => setFilter({ channel:  e.target.value }));
  interest?.addEventListener('change', (e) => setFilter({ interest: e.target.value }));

  btnClear?.addEventListener('click', () => {
    clearFilters();
    resetFilterInputs();
  });
}

function resetFilterInputs() {
  const ids = ['filter-search','filter-status','filter-assigned','filter-channel','filter-interest'];
  for (const id of ids) {
    const el = getEl(id);
    if (el) el.value = '';
  }
}

// ── Aplicar filtros ───────────────────────────────────────

export function applyFiltersAndRender() {
  const allLeads = getState('allLeads') || [];
  const filters  = getState('filters');

  let filtered = [...allLeads];

  // Búsqueda por texto
  if (filters.search) {
    const q = filters.search.toLowerCase();
    filtered = filtered.filter((l) =>
      (l.fullName  || '').toLowerCase().includes(q) ||
      (l.phone     || '').includes(q) ||
      (l.email     || '').toLowerCase().includes(q)
    );
  }

  if (filters.status)   filtered = filtered.filter((l) => l.revisionStatus === filters.status);
  if (filters.assigned) filtered = filtered.filter((l) => l.assignedTo     === filters.assigned);
  if (filters.channel)  filtered = filtered.filter((l) => (l.channel || '').toLowerCase() === filters.channel.toLowerCase());
  if (filters.interest) filtered = filtered.filter((l) => l.possibleInterest === filters.interest);

  setState({ filteredLeads: filtered, currentPage: 1 });
  renderCurrentPage();
  updateLeadsSubtitle(filtered.length, allLeads.length);
}

// ── Renderizado de la tabla ───────────────────────────────

function renderCurrentPage() {
  const filtered   = getState('filteredLeads') || [];
  const page       = getState('currentPage') || 1;
  const start      = (page - 1) * PAGE_SIZE;
  const pageLeads  = filtered.slice(start, start + PAGE_SIZE);

  renderLeadsTable(pageLeads);
  renderPagination(filtered.length, page);
}

function renderLeadsTable(leads) {
  const tbody = getEl('leads-tbody');
  if (!tbody) return;

  if (!leads.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="table-empty">
          <div class="empty-state-inner">
            <span class="empty-icon">♩</span>
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
        ${lead.lastMessageAt
          ? `<br/><span style="font-size:11px;color:var(--c-text-soft);">${formatRelativeDate(lead.lastMessageAt)}</span>`
          : ''}
      </td>
      <td>
        <span class="badge badge--interest" style="font-size:11px;">
          ${escHtml(lead.possibleInterest || 'Sin clasificar')}
        </span>
      </td>
      <td>${statusBadge(lead.revisionStatus)}</td>
      <td style="font-size:13px;">${escHtml(lead.assignedTo || 'Sin asignar')}</td>
      <td style="font-size:11px;color:var(--c-text-soft);">
        ${lead.updatedAt ? formatDate(lead.updatedAt) : '—'}
      </td>
      <td class="col-actions">
        <button class="btn-open-lead" data-lead-id="${escHtml(lead.id)}">
          Ver
        </button>
      </td>
    </tr>
  `).join('');

  // Delegar evento de apertura de ficha
  tbody.querySelectorAll('.btn-open-lead').forEach((btn) => {
    btn.addEventListener('click', () => {
      const leadId = btn.dataset.leadId;
      openLeadDetail(leadId);
    });
  });
}

// ── Paginación ────────────────────────────────────────────

function renderPagination(total, currentPage) {
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const infoEl     = getEl('pagination-info');
  const btnPrev    = getEl('btn-prev-page');
  const btnNext    = getEl('btn-next-page');

  if (infoEl) {
    const start = total === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
    const end   = Math.min(currentPage * PAGE_SIZE, total);
    infoEl.textContent = total > 0 ? `${start}–${end} de ${total}` : '0 resultados';
  }

  if (btnPrev) btnPrev.disabled = currentPage <= 1;
  if (btnNext) btnNext.disabled = currentPage >= totalPages;
}

function bindPagination() {
  getEl('btn-prev-page')?.addEventListener('click', () => {
    const page = getState('currentPage') || 1;
    if (page > 1) setState({ currentPage: page - 1 });
  });

  getEl('btn-next-page')?.addEventListener('click', () => {
    const filtered   = getState('filteredLeads') || [];
    const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
    const page       = getState('currentPage') || 1;
    if (page < totalPages) setState({ currentPage: page + 1 });
  });
}

// ── Exportar ──────────────────────────────────────────────

function bindExportButton() {
  getEl('btn-export-csv')?.addEventListener('click', () => {
    const filtered = getState('filteredLeads') || getState('allLeads') || [];
    try {
      exportLeadsToCSV(filtered);
      showSuccess(`CSV exportado con ${filtered.length} contactos.`);
    } catch (err) {
      showError(err.message);
    }
  });
}

// ── Subtitle ──────────────────────────────────────────────

function updateLeadsSubtitle(filtered, total) {
  const el = getEl('leads-subtitle');
  if (!el) return;
  el.textContent = filtered === total
    ? `${total} contactos importados`
    : `${filtered} de ${total} contactos (filtro activo)`;
}

// ── Navegación a ficha ────────────────────────────────────

function openLeadDetail(leadId) {
  const leads = getState('allLeads') || [];
  const lead  = leads.find((l) => l.id === leadId);
  if (!lead) return;

  setState({ currentLead: lead });
  // Disparar navegación a la vista de detalle
  document.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'lead-detail' } }));
}

// ── Helper ────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
