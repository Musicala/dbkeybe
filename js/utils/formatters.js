// ─────────────────────────────────────────────────────────
// formatters.js — Funciones de formato para la UI
// ─────────────────────────────────────────────────────────

import { REVISION_STATUS, CHANNELS } from './constants.js';

/**
 * Formatea un Timestamp de Firestore o un Date a string legible en español.
 * Retorna '—' si el valor es nulo o inválido.
 */
export function formatDate(value, includeTime = false) {
  if (!value) return '—';

  let date;
  if (value?.toDate) {
    date = value.toDate();           // Firestore Timestamp
  } else if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string' || typeof value === 'number') {
    date = new Date(value);
  } else {
    return '—';
  }

  if (isNaN(date.getTime())) return '—';

  const options = {
    year:  'numeric',
    month: 'short',
    day:   'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  };

  return date.toLocaleDateString('es-CO', options);
}

/**
 * Formatea fecha relativa (hace X minutos / horas / días).
 */
export function formatRelativeDate(value) {
  if (!value) return '—';

  let date;
  if (value?.toDate) date = value.toDate();
  else if (value instanceof Date) date = value;
  else date = new Date(value);

  if (isNaN(date.getTime())) return '—';

  const now    = Date.now();
  const diff   = now - date.getTime();
  const mins   = Math.floor(diff / 60_000);
  const hours  = Math.floor(diff / 3_600_000);
  const days   = Math.floor(diff / 86_400_000);

  if (mins < 1)   return 'Ahora mismo';
  if (mins < 60)  return `hace ${mins} min`;
  if (hours < 24) return `hace ${hours} h`;
  if (days < 7)   return `hace ${days} días`;
  return formatDate(date);
}

/**
 * Etiqueta en español para un estado de revisión.
 */
export function formatStatus(statusKey) {
  return REVISION_STATUS[statusKey] ?? statusKey ?? '—';
}

/**
 * Etiqueta en español para un canal.
 */
export function formatChannel(channelKey) {
  if (!channelKey) return '—';
  return CHANNELS[channelKey.toLowerCase()] ?? channelKey;
}

/**
 * Trunca un texto largo para mostrar en tabla.
 */
export function truncate(text, maxLength = 60) {
  if (!text) return '—';
  const str = String(text).trim();
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '…';
}

/**
 * Formatea nombre completo: capitaliza primera letra de cada palabra.
 */
export function formatName(name, surname) {
  const cap = (s) =>
    String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());

  const n = cap(name);
  const s = cap(surname);

  if (n && s) return `${n} ${s}`;
  return n || s || '—';
}

/**
 * Devuelve las iniciales de un nombre para el avatar.
 */
export function getInitials(fullName) {
  if (!fullName) return '?';
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Genera el HTML del badge de estado de revisión.
 */
export function statusBadge(statusKey) {
  const label = formatStatus(statusKey);
  return `<span class="badge badge--${statusKey}">${label}</span>`;
}

/**
 * Genera el HTML del badge de canal.
 */
export function channelBadge(channelKey) {
  const label = formatChannel(channelKey);
  return `<span class="badge badge--channel">${label}</span>`;
}

/**
 * Porcentaje formateado.
 */
export function formatPct(numerator, denominator) {
  if (!denominator || denominator === 0) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}
