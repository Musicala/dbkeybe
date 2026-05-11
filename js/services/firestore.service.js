// ─────────────────────────────────────────────────────────
// firestore.service.js — CRUD con Cloud Firestore
// ─────────────────────────────────────────────────────────

import {
  collection, doc,
  getDocs, getDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, startAfter,
  serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { db }          from '../config/firebase.config.js';
import { COLLECTIONS } from '../utils/constants.js';

// ── Helpers ──────────────────────────────────────────────

function leadsRef() {
  return collection(db, COLLECTIONS.KEYBE_LEADS);
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
  const snap = await getDoc(ref);
  const legacyLead = snap.exists() ? null : await findLegacyLeadForImport(docId, data);
  const payload = snap.exists()
    ? stripReviewFields(data)
    : legacyLead
    ? { ...data, ...pickReviewFields(legacyLead.data), migratedFrom: legacyLead.id }
    : data;
  await setDoc(ref, payload, { merge: true });

  if (legacyLead) {
    await setDoc(doc(db, COLLECTIONS.KEYBE_LEADS, legacyLead.id), {
      migratedTo: docId,
      migrationStatus: 'migrated_phone_fixed',
      migrationReason: 'Telefono reparado en reimportacion Keybe',
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }
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
  await updateDoc(ref, {
    ...reviewData,
    updatedAt: serverTimestamp(),
  });
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
