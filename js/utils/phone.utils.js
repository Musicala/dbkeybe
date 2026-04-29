// ─────────────────────────────────────────────────────────
// phone.utils.js — Normalización de números de teléfono
// ─────────────────────────────────────────────────────────

/**
 * Normaliza un número de teléfono para usar como clave única.
 * Elimina espacios, guiones, paréntesis y prefijos internacionales comunes.
 * Retorna solo dígitos (10 para Colombia, o los que haya).
 *
 * Ejemplos:
 *   "+57 310 123 4567" → "3101234567"
 *   "57-3101234567"    → "3101234567"
 *   "(310) 123-4567"   → "3101234567"
 *   "3101234567"       → "3101234567"
 */
export function normalizePhone(raw) {
  if (!raw) return '';

  // Convertir a string y quitar todo excepto dígitos y el '+' inicial
  let cleaned = String(raw).trim().replace(/[\s\-().]/g, '');

  // Quitar el '+' si hay
  cleaned = cleaned.replace(/^\+/, '');

  // Quitar prefijo de país Colombia (57) si el número tiene más de 10 dígitos
  if (cleaned.length === 12 && cleaned.startsWith('57')) {
    cleaned = cleaned.slice(2);
  }

  // Quitar prefijo 0057
  if (cleaned.length === 14 && cleaned.startsWith('0057')) {
    cleaned = cleaned.slice(4);
  }

  return cleaned;
}

/**
 * Compara si dos teléfonos son el mismo después de normalizar.
 */
export function isSamePhone(a, b) {
  return normalizePhone(a) === normalizePhone(b);
}

/**
 * Formatea un teléfono normalizado para mostrar en UI.
 * "3101234567" → "310 123 4567"
 */
export function displayPhone(normalized) {
  if (!normalized) return '—';
  const d = String(normalized).replace(/\D/g, '');
  if (d.length === 10) {
    return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  }
  return d || '—';
}

/**
 * Genera un link de WhatsApp para un teléfono.
 */
export function whatsappLink(normalized) {
  if (!normalized) return null;
  return `https://wa.me/57${normalized}`;
}
