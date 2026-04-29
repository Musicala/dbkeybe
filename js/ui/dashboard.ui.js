// dashboard.ui.js - Resumen y estadisticas.

import { getState } from '../utils/state.js';
import { calcStats, getRecentActivity } from '../services/firestore.service.js';
import { formatRelativeDate, formatStatus } from '../utils/formatters.js';

const getEl = (id) => document.getElementById(id);

export function renderDashboard() {
  const leads = getState('allLeads');

  if (!leads || leads.length === 0) {
    renderEmptyDashboard();
    return;
  }

  const stats = calcStats(leads);
  renderStats(stats);
  renderProgress(stats);
  renderRecentActivity(leads);
  updateSubtitle(leads);
}

function renderStats(stats) {
  setText('stat-total', stats.total);
  setText('stat-original-rows', stats.originalRows || stats.total);
  setText('stat-pending', stats.pending);
  setText('stat-in-base', stats.inBase);
  setText('stat-not-in-base', stats.notInBase);
  setText('stat-to-contact', stats.toContact);
  setText('stat-duplicate', stats.duplicate);
  setText('stat-discarded', stats.discarded);
  setText('stat-today', stats.today);
}

function renderProgress(stats) {
  const pct = stats.progressPct ?? 0;
  const fill = getEl('progress-fill');
  const pctText = getEl('progress-pct');
  const track = getEl('progress-track');
  const caption = getEl('progress-caption');

  if (fill) fill.style.width = `${pct}%`;
  if (pctText) pctText.textContent = `${pct}%`;
  if (track) track.setAttribute('aria-valuenow', pct);

  if (caption) {
    caption.textContent = stats.total > 0
      ? `${stats.reviewed} de ${stats.total} contactos revisados manualmente. Los duplicados no cuentan como revisados por si solos.`
      : 'Sin datos aun.';
  }
}

function renderRecentActivity(leads) {
  const container = getEl('recent-activity');
  if (!container) return;

  const recent = getRecentActivity(leads, 8);

  if (!recent.length) {
    container.innerHTML = '<p class="empty-state">No hay actividad registrada todavia.</p>';
    return;
  }

  container.innerHTML = recent.map((lead) => `
    <div class="recent-item">
      <div class="sidebar-user-avatar" style="width:28px;height:28px;font-size:12px;flex-shrink:0;">
        ${escHtml((lead.fullName || '?')[0].toUpperCase())}
      </div>
      <div>
        <span class="recent-item-name">${escHtml(lead.fullName || '(Sin nombre)')}</span>
        <span style="font-size:12px;color:var(--c-text-soft);margin-left:8px;">
          -> ${escHtml(formatStatus(lead.revisionStatus))}
        </span>
        ${lead.reviewedBy ? `<span style="font-size:11px;color:var(--c-text-soft);margin-left:4px;">por ${escHtml(lead.reviewedBy)}</span>` : ''}
      </div>
      <span class="recent-item-time">${formatRelativeDate(lead.reviewedAt)}</span>
    </div>
  `).join('');
}

function renderEmptyDashboard() {
  const statIds = [
    'stat-total', 'stat-original-rows', 'stat-pending', 'stat-in-base', 'stat-not-in-base',
    'stat-to-contact', 'stat-duplicate', 'stat-discarded', 'stat-today',
  ];

  for (const id of statIds) setText(id, '0');

  const fill = getEl('progress-fill');
  const pctText = getEl('progress-pct');
  const caption = getEl('progress-caption');

  if (fill) fill.style.width = '0%';
  if (pctText) pctText.textContent = '0%';
  if (caption) caption.textContent = 'Sin datos aun. Importa los archivos de Keybe para comenzar.';

  const container = getEl('recent-activity');
  if (container) container.innerHTML = '<p class="empty-state">No hay actividad registrada todavia.</p>';

  updateSubtitle([]);
}

function updateSubtitle(leads) {
  const el = getEl('dashboard-subtitle');
  if (!el) return;
  el.textContent = leads.length > 0
    ? `${leads.length} contactos unicos importados · Ultima actualizacion: ${new Date().toLocaleDateString('es-CO')}`
    : 'Sin datos importados todavia.';
}

function setText(id, value) {
  const el = getEl(id);
  if (el) el.textContent = value;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
