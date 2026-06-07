// dashboard.ui.js - Resumen y estadisticas.

import { getDashboardStats, recalcDashboardStatsFromFirestore, getRecentActivityPage } from '../services/firestore.service.js';
import { formatRelativeDate, formatStatus } from '../utils/formatters.js';

const getEl = (id) => document.getElementById(id);

export async function renderDashboard({ forceRecalc = false } = {}) {
  try {
    let [stats, recent] = await Promise.all([
      getDashboardStats(),
      getRecentActivityPage(8),
    ]);

    // Si no hay stats guardadas o el total es 0, recalcular desde Firestore.
    // Esto cubre el caso donde el import fue pausado antes de completarse.
    const needsRecalc = forceRecalc || !stats || stats.total == null || stats.total === 0;
    if (needsRecalc) {
      try {
        stats = await recalcDashboardStatsFromFirestore();
      } catch (recalcErr) {
        console.warn('No se pudo recalcular stats desde Firestore:', recalcErr);
      }
    }

    if (!stats || stats.total === 0) {
      renderEmptyDashboard();
      return;
    }

    renderStats(stats);
    renderProgress(stats);
    renderRecentActivity(recent);
    updateSubtitle(stats);
  } catch (err) {
    console.error('Error cargando dashboard:', err);
    renderEmptyDashboard();
  }
}

function renderStats(stats) {
  setText('stat-total', stats.total || 0);
  setText('stat-original-rows', stats.originalRows || stats.total || 0);
  setText('stat-pending', stats.pending || 0);
  setText('stat-in-base', stats.inBase || 0);
  setText('stat-not-in-base', stats.notInBase || 0);
  setText('stat-to-contact', stats.toContact || 0);
  setText('stat-duplicate', stats.duplicate || 0);
  setText('stat-discarded', stats.discarded || 0);
  setText('stat-today', stats.today || 0);
}

function renderProgress(stats) {
  const pct = stats.total > 0 ? Math.round(((stats.reviewed || 0) / stats.total) * 100) : (stats.progressPct ?? 0);
  const fill = getEl('progress-fill');
  const pctText = getEl('progress-pct');
  const track = getEl('progress-track');
  const caption = getEl('progress-caption');

  if (fill) fill.style.width = `${pct}%`;
  if (pctText) pctText.textContent = `${pct}%`;
  if (track) track.setAttribute('aria-valuenow', pct);

  if (caption) {
    caption.textContent = stats.total > 0
      ? `${stats.reviewed || 0} de ${stats.total} contactos revisados manualmente. Los duplicados no cuentan como revisados por si solos.`
      : 'Sin datos aun.';
  }
}

function renderRecentActivity(recent) {
  const container = getEl('recent-activity');
  if (!container) return;

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

  updateSubtitle(null);
}

function updateSubtitle(stats) {
  const el = getEl('dashboard-subtitle');
  if (!el) return;
  const total = stats?.total || 0;
  const updatedAt = stats?.updatedAt?.toDate ? stats.updatedAt.toDate() : stats?.updatedAt ? new Date(stats.updatedAt) : null;
  el.textContent = total > 0
    ? `${total} contactos unicos importados - ${stats?.isEstimatedFromCounts ? 'Resumen calculado por conteos' : `Ultima actualizacion: ${updatedAt ? updatedAt.toLocaleDateString('es-CO') : new Date().toLocaleDateString('es-CO')}`}`
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
