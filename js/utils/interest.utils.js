// ─────────────────────────────────────────────────────────
// interest.utils.js — Detección de interés desde mensajes
// ─────────────────────────────────────────────────────────

import { INTERESTS, INTEREST_KEYWORDS } from './constants.js';

/**
 * Detecta el posible interés de un contacto a partir de los textos
 * de sus mensajes.
 *
 * Estrategia: recorre todos los mensajes del contacto, acumula
 * coincidencias por categoría, y retorna la de mayor puntaje.
 * Si hay empate, gana "Información comercial" > el orden del objeto.
 *
 * @param {string[]} texts — array de textos de mensajes
 * @returns {string} — uno de los valores de INTERESTS
 */
export function detectInterest(texts) {
  if (!texts || texts.length === 0) return INTERESTS.SIN_CLASIFICAR;

  const scores = {};
  for (const interest of Object.keys(INTEREST_KEYWORDS)) {
    scores[interest] = 0;
  }

  const combined = texts
    .map((t) => String(t || '').toLowerCase())
    .join(' ');

  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    for (const kw of keywords) {
      // Busca la palabra completa o como parte de una palabra
      if (combined.includes(kw.toLowerCase())) {
        scores[interest] += 1;
      }
    }
  }

  // Encontrar el de mayor puntaje
  let maxScore = 0;
  let detected = INTERESTS.SIN_CLASIFICAR;

  for (const [interest, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      detected = interest;
    }
  }

  return detected;
}

/**
 * Versión para un solo texto (útil para analizar un único mensaje).
 * @param {string} text
 * @returns {string}
 */
export function detectInterestFromText(text) {
  return detectInterest([text]);
}

export function detectInterestTags(texts) {
  const combined = (texts || [])
    .map((t) => String(t || '').toLowerCase())
    .join(' ');

  const groups = {
    Musica: ['musica', 'música', 'instrumento', 'clase musical'],
    Danza: ['danza', 'baile', 'ballet', 'porras', 'salsa'],
    'Artes plasticas': ['artes plasticas', 'artes plásticas', 'pintura', 'dibujo', 'arte'],
    Teatro: ['teatro', 'actuacion', 'actuación', 'escena'],
    Piano: ['piano'],
    Guitarra: ['guitarra'],
    Canto: ['canto', 'vocal'],
    Bateria: ['bateria', 'batería'],
    Violin: ['violin', 'violín'],
    Ninos: ['niño', 'nino', 'niña', 'nina', 'infantil', 'hijo', 'hija'],
    Adultos: ['adulto', 'adultos'],
    Vacacional: ['vacacional', 'vacaciones'],
    Precios: ['precio', 'precios', 'costo', 'valor', 'mensualidad', 'tarifa'],
    Horarios: ['horario', 'horarios', 'hora disponible'],
    Ubicacion: ['ubicacion', 'ubicación', 'direccion', 'dirección', 'sede'],
    Inscripcion: ['inscripcion', 'inscripción', 'matricula', 'matrícula', 'registrar'],
  };

  return Object.entries(groups)
    .filter(([, keywords]) => keywords.some((kw) => combined.includes(kw)))
    .map(([tag]) => tag);
}
