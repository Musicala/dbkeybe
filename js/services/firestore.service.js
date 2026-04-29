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
export async function getAllLeads() {
  const q    = query(leadsRef(), orderBy('createdAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
  const payload = snap.exists() ? stripReviewFields(data) : data;
  await setDoc(ref, payload, { merge: true });
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
