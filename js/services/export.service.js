// ─────────────────────────────────────────────────────────
// export.service.js — Exportación a CSV
// ─────────────────────────────────────────────────────────

import { formatDate, formatStatus, formatChannel } from '../utils/formatters.js';

/**
 * Genera y descarga un archivo CSV con el estado actual de los leads.
 *
 * @param {Object[]} leads — array de leads (ya filtrados si se desea)
 * @param {string} filename — nombre del archivo sin extensión
 */
export function exportLeadsToCSV(leads, filename = 'keybe-verificacion') {
  if (!leads || leads.length === 0) {
    throw new Error('No hay contactos para exportar.');
  }

  const headers = [
    'Nombre completo',
    'Teléfono',
    'Correo',
    'Estado de revisión',
    'En base oficial',
    'Responsable',
    'Nota interna',
    'Revisado por',
    'Fecha de revisión',
    'Canal',
    'Último mensaje',
    'Posible interés',
    'Cantidad de mensajes',
    'Fecha último mensaje',
    'UUID Keybe',
  ];

  const rows = leads.map((lead) => [
    csvEscape(lead.fullName || ''),
    csvEscape(lead.phone || ''),
    csvEscape(lead.email || ''),
    csvEscape(formatStatus(lead.revisionStatus)),
    csvEscape(formatInBase(lead.isInOfficialDatabase)),
    csvEscape(lead.assignedTo || 'Sin asignar'),
    csvEscape(lead.internalNote || ''),
    csvEscape(lead.reviewedBy || ''),
    csvEscape(formatDate(lead.reviewedAt, true)),
    csvEscape(formatChannel(lead.channel)),
    csvEscape(lead.lastMessage || ''),
    csvEscape(lead.possibleInterest || ''),
    csvEscape(String(lead.messageCount ?? 0)),
    csvEscape(formatDate(lead.lastMessageAt, true)),
    csvEscape(lead.keybeContactUuid || ''),
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map((r) => r.join(',')),
  ].join('\r\n');

  // BOM para que Excel lo abra bien en español
  const bom  = '\uFEFF';
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href     = url;
  link.download = `${filename}-${dateStamp()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ── Helpers ───────────────────────────────────────────────

function csvEscape(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value).replace(/"/g, '""');
  return `"${str}"`;
}

function formatInBase(val) {
  if (val === true  || val === 'true')  return 'Sí';
  if (val === false || val === 'false') return 'No';
  return 'Sin verificar';
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
