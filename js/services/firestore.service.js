// ─────────────────────────────────────────────────────────
// firestore.service.js — CRUD con Cloud Firestore
// ─────────────────────────────────────────────────────────

import {
  collection, doc,
  getDocs, getDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, startAfter,
  increment, serverTimestamp, Timestamp,
  getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { db }          from '../config/firebase.config.js';
import { COLLECTIONS } from '../utils/constants.js';

// ── Helpers ──────────────────────────────────────────────

function leadsRef() {
  return collection(db, COLLECTIONS.KEYBE_LEADS);
}

function statsRef() {
  return doc(db, COLLECTIONS.KEYBE_STATS, 'summary');
}

function stripReviewFields(data) {
  const {
    revisionStatus,
    isInOfficialDatabase,
    assignedTo,
    internalNote,
    reviewedBy,
    reviewedByEmail,
    reviewedAt,
    ...rest
  } = data;

  return rest;
}

// ── Leads ─────────────────────────────────────────────────

/**
 * Obtiene TODOS los leads de la colección keybeLeads.
 * Para esta app de uso interno el volumen es manejable en memoria.
 *
 * @returns {Promise<Object[]>}
 */
function pickReviewFields(data) {
  return {
    revisionStatus: data.revisionStatus ?? 'pendiente_revision',
    isInOfficialDatabase: data.isInOfficialDatabase ?? null,
    assignedTo: data.assignedTo ?? 'Sin asignar',
    internalNote: data.internalNote ?? '',
    reviewedBy: data.reviewedBy ?? null,
    reviewedByEmail: data.reviewedByEmail ?? null,
    reviewedAt: data.reviewedAt ?? null,
  };
}

async function findLegacyLeadForImport(newDocId, data) {
  const candidates = [];

  if (data.keybeContactUuid) {
    const snap = await getDocs(query(leadsRef(), where('keybeContactUuid', '==', data.keybeContactUuid), limit(5)));
    candidates.push(...snap.docs);
  }

  if (!candidates.length && data.email) {
    const snap = await getDocs(query(leadsRef(), where('email', '==', data.email), limit(5)));
    candidates.push(...snap.docs);
  }

  const found = candidates
    .map((snap) => ({ id: snap.id, data: snap.data() }))
    .find((lead) => lead.id !== newDocId && !lead.data.migratedTo && isLikelyBadPhoneLead(lead));

  return found || null;
}

function isLikelyBadPhoneLead(lead) {
  const data = lead.data || {};
  const phone = String(data.phone || lead.id || '').replace(/\D/g, '');
  const phoneRaw = String(data.phoneRaw || '').trim();
  const recoveredScientific = data.dataQuality?.phoneWasRecoveredFromScientificNotation === true;

  if (!phone) return true;
  if (phone.length !== 10) return true;
  if (!phone.startsWith('3')) return true;

  // Importaciones antiguas pudieron guardar telefonos redondeados por Excel:
  // 5.73507E+11 -> 573507000000 -> 3507000000.
  // Si el raw venia en notacion cientifica corta y el telefono termina en varios ceros,
  // lo tratamos como legacy corrupto para migrarlo al doc nuevo por uuid/email.
  if (recoveredScientific && looksLikeRoundedScientific(phoneRaw) && /0{4,}$/.test(phone)) {
    return true;
  }

  return false;
}

function looksLikeRoundedScientific(value) {
  const text = String(value || '').trim().replace(',', '.').replace(/\s+/g, '');
  const match = text.match(/^[+-]?(\d+)(?:\.(\d+))?e[+-]?\d+$/i);
  if (!match) return false;
  const significantDigits = `${match[1] || ''}${match[2] || ''}`.replace(/^0+/, '').length;
  return significantDigits > 0 && significantDigits < 10;
}

export async function getAllLeads() {
  const q    = query(leadsRef(), orderBy('createdAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((lead) => !lead.migratedTo);
}

export async function loadLeadsPage(options = {}) {
  const pageSize = Number(options.pageSize || 25);
  const clauses = [];
  const search = String(options.search || '').trim();

  if (options.status) clauses.push(where('revisionStatus', '==', options.status));
  if (options.assigned) clauses.push(where('assignedTo', '==', options.assigned));
  if (options.channel) clauses.push(where('channel', '==', String(options.channel).toLowerCase()));
  if (options.interest) clauses.push(where('possibleInterest', '==', options.interest));

  let orderField = 'updatedAt';
  let orderDirection = 'desc';

  if (search) {
    const term = search.toLowerCase();
    const digits = search.replace(/\D/g, '');
    if (looksLikeEmail(term)) {
      clauses.push(where('email', '==', term));
    } else if (digits.length >= 6) {
      clauses.push(where('phone', '==', digits.slice(-10)));
    } else {
      orderField = 'nameLower';
      orderDirection = 'asc';
      clauses.push(where('nameLower', '>=', term));
      clauses.push(where('nameLower', '<=', `${term}\uf8ff`));
    }
  }

  clauses.push(orderBy(orderField, orderDirection));
  if (orderField !== 'updatedAt') clauses.push(orderBy('updatedAt', 'desc'));
  if (options.cursor) clauses.push(startAfter(options.cursor));
  clauses.push(limit(pageSize + 1));

  const snap = await getDocs(query(leadsRef(), ...clauses));
  const docs = snap.docs.slice(0, pageSize);
  return {
    leads: docs.map((d) => normalizeLeadSnapshot(d)),
    cursor: docs[docs.length - 1] || null,
    hasMore: snap.docs.length > pageSize,
  };
}

function normalizeLeadSnapshot(snap) {
  const data = snap.data();
  return {
    id: snap.id,
    ...data,
    revisionStatus: data.revisionStatus || 'pendiente_revision',
  };
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

/**
 * Obtiene un lead por su ID de documento.
 *
 * @param {string} leadId
 * @returns {Promise<Object|null>}
 */
export async function getLeadById(leadId) {
  const snap = await getDoc(doc(db, COLLECTIONS.KEYBE_LEADS, leadId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Crea o reemplaza un lead completo.
 * Usa el teléfono normalizado como ID para evitar duplicados.
 *
 * @param {string} docId — teléfono normalizado
 * @param {Object} data
 */
export async function upsertLead(docId, data) {
  const ref = doc(db, COLLECTIONS.KEYBE_LEADS, docId);
  const cleanData = stripReviewFields(data);
  const payload = {
    ...cleanData,
    nameLower: buildNameLower(cleanData),
    searchableName: buildNameLower(cleanData),
  };
  await setDoc(ref, payload, { merge: true });
}

function buildNameLower(data) {
  return String(data.fullName || [data.name, data.surname].filter(Boolean).join(' ') || '')
    .trim()
    .toLowerCase();
}

/**
 * Actualiza solo los campos de revisión de un lead.
 * Los asistentes solo pueden modificar estos campos.
 *
 * @param {string} leadId
 * @param {Object} reviewData
 */
export async function updateLeadReview(leadId, reviewData) {
  const ref = doc(db, COLLECTIONS.KEYBE_LEADS, leadId);
  const beforeSnap = await getDoc(ref);
  const before = beforeSnap.exists() ? beforeSnap.data() : null;
  await updateDoc(ref, {
    ...reviewData,
    updatedAt: serverTimestamp(),
  });
  await updateDashboardStatsForReview(before, reviewData);
}

/**
 * Elimina un lead. Solo admin.
 *
 * @param {string} leadId
 */
export async function deleteLead(leadId) {
  await deleteDoc(doc(db, COLLECTIONS.KEYBE_LEADS, leadId));
}

// ── Estadísticas del dashboard ────────────────────────────

/**
 * Calcula estadísticas de resumen leyendo todos los leads en memoria.
 * (Más eficiente que múltiples queries para esta escala.)
 *
 * @param {Object[]} leads — array ya cargado en estado
 * @returns {Object} stats
 */
export function calcStats(leads) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const stats = {
    total:        leads.length,
    originalRows: 0,
    pending:      0,
    inBase:       0,
    notInBase:    0,
    toContact:    0,
    duplicate:    0,
    discarded:    0,
    matriculado:  0,
    today:        0,
    reviewed:     0,
  };

  for (const lead of leads) {
    stats.originalRows += lead.importMetrics?.sourceRows || lead.duplicateCount || 1;
    if (lead.isDuplicate === true || lead.revisionStatus === 'duplicado') stats.duplicate++;

    switch (lead.revisionStatus) {
      case 'pendiente_revision': stats.pending++;     break;
      case 'ya_esta_en_base':    stats.inBase++;      break;
      case 'no_esta_en_base':    stats.notInBase++;   break;
      case 'debe_contactarse':   stats.toContact++;   break;
      case 'duplicado':
        if (!lead.reviewedAt) stats.pending++;
        break;
      case 'descartado':         stats.discarded++;   break;
      case 'matriculado':        stats.matriculado++; break;
    }

    if (lead.reviewedAt || [
      'ya_esta_en_base',
      'no_esta_en_base',
      'debe_contactarse',
      'descartado',
      'matriculado',
    ].includes(lead.revisionStatus)) {
      stats.reviewed++;
    }

    // Revisados hoy
    if (lead.reviewedAt) {
      const rev = lead.reviewedAt?.toDate ? lead.reviewedAt.toDate() : new Date(lead.reviewedAt);
      if (rev >= today) stats.today++;
    }
  }

  stats.progressPct = stats.total > 0
    ? Math.round((stats.reviewed / stats.total) * 100)
    : 0;

  return stats;
}

// ── Actividad reciente ─────────────────────────────────────

/**
 * Retorna los N leads más recientemente actualizados.
 *
 * @param {Object[]} leads
 * @param {number} n
 * @returns {Object[]}
 */
export function getRecentActivity(leads, n = 8) {
  return [...leads]
    .filter((l) => l.reviewedAt)
    .sort((a, b) => {
      const ta = a.reviewedAt?.toDate ? a.reviewedAt.toDate() : new Date(a.reviewedAt ?? 0);
      const tb = b.reviewedAt?.toDate ? b.reviewedAt.toDate() : new Date(b.reviewedAt ?? 0);
      return tb - ta;
    })
    .slice(0, n);
}

export async function getDashboardStats() {
  const snap = await getDoc(statsRef());
  return snap.exists() ? snap.data() : null;
}

export async function saveDashboardStats(stats) {
  await setDoc(statsRef(), {
    ...stats,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

/**
 * Recalcula las estadísticas del dashboard directamente desde Firestore
 * usando getCountFromServer (solo 8 lecturas, sin descargar documentos).
 * Úsalo cuando el doc de stats esté vacío, al pausar, o al hacer clic en "Actualizar".
 */
export async function recalcDashboardStatsFromFirestore() {
  const ref = leadsRef();

  const [
    totalSnap,
    pendingSnap,
    inBaseSnap,
    notInBaseSnap,
    toContactSnap,
    discardedSnap,
    matriculadoSnap,
    duplicateSnap,
  ] = await Promise.all([
    getCountFromServer(query(ref)),
    getCountFromServer(query(ref, where('revisionStatus', '==', 'pendiente_revision'))),
    getCountFromServer(query(ref, where('revisionStatus', '==', 'ya_esta_en_base'))),
    getCountFromServer(query(ref, where('revisionStatus', '==', 'no_esta_en_base'))),
    getCountFromServer(query(ref, where('revisionStatus', '==', 'debe_contactarse'))),
    getCountFromServer(query(ref, where('revisionStatus', '==', 'descartado'))),
    getCountFromServer(query(ref, where('revisionStatus', '==', 'matriculado'))),
    getCountFromServer(query(ref, where('isDuplicate', '==', true))),
  ]);

  const total      = totalSnap.data().count;
  const pending    = pendingSnap.data().count;
  const inBase     = inBaseSnap.data().count;
  const notInBase  = notInBaseSnap.data().count;
  const toContact  = toContactSnap.data().count;
  const discarded  = discardedSnap.data().count;
  const matriculado = matriculadoSnap.data().count;
  const duplicate  = duplicateSnap.data().count;
  const reviewed   = inBase + notInBase + toContact + discarded + matriculado;

  const stats = {
    total,
    pending,
    inBase,
    notInBase,
    toContact,
    discarded,
    matriculado,
    duplicate,
    reviewed,
    today: 0,
    progressPct: total > 0 ? Math.round((reviewed / total) * 100) : 0,
    isEstimatedFromCounts: true,
  };

  await saveDashboardStats(stats);
  return stats;
}

async function updateDashboardStatsForReview(before, after) {
  if (!before) return;
  const deltas = {};
  const beforeStatus = before.revisionStatus || 'pendiente_revision';
  const afterStatus = after.revisionStatus || beforeStatus;

  addStatusDelta(deltas, beforeStatus, -1);
  addStatusDelta(deltas, afterStatus, 1);

  const wasReviewed = isReviewedLead(before);
  const isReviewed = isReviewedLead({ ...before, ...after });
  if (!wasReviewed && isReviewed) deltas.reviewed = increment(1);
  if (wasReviewed && !isReviewed) deltas.reviewed = increment(-1);

  const oldDuplicate = before.isDuplicate === true || beforeStatus === 'duplicado';
  const newDuplicate = before.isDuplicate === true || afterStatus === 'duplicado';
  if (oldDuplicate !== newDuplicate) deltas.duplicate = increment(newDuplicate ? 1 : -1);

  if (!wasReviewed && isReviewed && isToday(after.reviewedAt || new Date())) {
    deltas.today = increment(1);
  }

  if (!Object.keys(deltas).length) return;
  await setDoc(statsRef(), {
    ...deltas,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

function addStatusDelta(deltas, status, amount) {
  const field = {
    pendiente_revision: 'pending',
    ya_esta_en_base: 'inBase',
    no_esta_en_base: 'notInBase',
    debe_contactarse: 'toContact',
    descartado: 'discarded',
    matriculado: 'matriculado',
  }[status];
  if (field) deltas[field] = increment(amount);
}

function isReviewedLead(lead) {
  return Boolean(lead.reviewedAt) || [
    'ya_esta_en_base',
    'no_esta_en_base',
    'debe_contactarse',
    'descartado',
    'matriculado',
  ].includes(lead.revisionStatus);
}

function isToday(value) {
  const d = value?.toDate ? value.toDate() : value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  return d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth()
    && d.getDate() === today.getDate();
}

export async function getRecentActivityPage(n = 8) {
  const snap = await getDocs(query(
    leadsRef(),
    orderBy('reviewedAt', 'desc'),
    limit(n)
  ));
  return snap.docs.map((d) => normalizeLeadSnapshot(d)).filter((lead) => lead.reviewedAt);
}


// ── Batch import ──────────────────────────────────────────

/**
 * Sube un array de leads a Firestore en lotes de 400.
 * Cada lead usa su teléfono normalizado como ID del documento.
 *
 * @param {Object[]} leads
 * @param {Function} onProgress — callback(pct: number, msg: string)
 */
export async function batchUpsertLeads(leads, onProgress) {
  const total  = leads.length;
  let uploaded = 0;

  // Procesamos en lotes para no saturar la conexión
  const BATCH_SIZE = 50;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const chunk = leads.slice(i, i + BATCH_SIZE);

    await Promise.all(
      chunk.map((lead) => {
        const docId = lead.phone || `nophone_${Date.now()}_${Math.random()}`;
        const { _messages, ...leadData } = lead;
        return upsertLead(docId, leadData);
      })
    );

    uploaded += chunk.length;
    const pct = Math.round((uploaded / total) * 100);
    onProgress?.(pct, `Subiendo contactos… ${uploaded} de ${total}`);
  }
}

export async function saveImportBatch(importBatchId, data) {
  await setDoc(doc(db, COLLECTIONS.KEYBE_IMPORTS, importBatchId), {
    ...data,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function upsertUnlinkedConversations(conversations, onProgress) {
  const total = conversations.length;
  let saved = 0;
  const BATCH_SIZE = 25;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const chunk = conversations.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map((conv) => {
      const { id, ...data } = conv;
      return setDoc(doc(db, COLLECTIONS.KEYBE_UNLINKED_CONVERSATIONS, id), data, { merge: true });
    }));
    saved += chunk.length;
    const pct = total ? Math.round((saved / total) * 100) : 100;
    onProgress?.(pct, `Guardando conversaciones sin contacto... ${saved} de ${total}`);
  }

  return { saved };
}
