// ─────────────────────────────────────────────────────────
// leads.service.js — Servicio de contactos Keybe / Firestore
// ─────────────────────────────────────────────────────────
// Responsabilidades:
// - Leer contactos desde Firestore.
// - Crear/actualizar contactos importados desde Keybe.
// - Preservar campos de revisión cuando se reimportan datos.
// - Guardar estados de revisión, responsable y notas internas.
// - Filtrar contactos.
// - Calcular métricas del dashboard.
// - Exportar CSV.
//
// Colección esperada:
// keybeLeads/{phoneNormalized | keybeUuid | id generado}
//
// Y sí, este archivo intenta sobrevivir al caos típico de Excel,
// Firestore, columnas con nombres raros y humanos subiendo archivos
// como si fueran pergaminos medievales.
// ─────────────────────────────────────────────────────────

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  query,
  orderBy,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { db } from '../config/firebase.config.js';

import {
  COLLECTIONS,
  REVISION_STATUS,
  REVISION_STATUS_KEYS,
  RESPONSABLES,
  CHANNELS,
  INTERESTS,
  PAGE_SIZE,
  SOURCE_KEYBE,
} from '../utils/constants.js';

import { getState, setState } from '../utils/state.js';

// ─────────────────────────────────────────────────────────
// Configuración interna
// ─────────────────────────────────────────────────────────

const LEADS_COLLECTION = COLLECTIONS.KEYBE_LEADS;
const IMPORTS_COLLECTION = COLLECTIONS.IMPORTS || 'imports';

const DEFAULT_REVISION_STATUS = 'pendiente_revision';
const DEFAULT_RESPONSABLE = 'Sin asignar';

const REVIEW_FIELDS = [
  'revisionStatus',
  'inOfficialBase',
  'assignedTo',
  'internalNote',
  'reviewedBy',
  'reviewedAt',
];

const SEARCHABLE_FIELDS = [
  'fullName',
  'phone',
  'phoneNormalized',
  'email',
  'channel',
  'interest',
  'revisionStatus',
  'assignedTo',
  'internalNote',
  'lastMessage',
];

// ─────────────────────────────────────────────────────────
// Error propio del servicio
// ─────────────────────────────────────────────────────────

export class LeadsServiceError extends Error {
  constructor(message, code = 'leads/service-error') {
    super(message);
    this.name = 'LeadsServiceError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────
// Utilidades base
// ─────────────────────────────────────────────────────────

function safeString(value = '') {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeText(value = '') {
  return safeString(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeEmail(email = '') {
  return safeString(email).toLowerCase();
}

function normalizePhone(phone = '') {
  const raw = safeString(phone);

  if (!raw) return '';

  let digits = raw.replace(/\D/g, '');

  // Si viene como 00357..., etc., no inventamos.
  // Para Colombia, si son 10 dígitos y empieza en 3, asumimos celular.
  if (digits.length === 10 && digits.startsWith('3')) {
    digits = `57${digits}`;
  }

  // Si viene con 0 inicial antes del celular, lo limpiamos.
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return digits;
}

function normalizeBooleanOrNull(value) {
  if (value === true || value === false || value === null) return value;

  const text = normalizeText(value);

  if (['si', 'sí', 'true', '1', 'yes', 'y'].includes(text)) return true;
  if (['no', 'false', '0', 'n'].includes(text)) return false;

  return null;
}

function isValidRevisionStatus(status) {
  return REVISION_STATUS_KEYS.includes(status);
}

function normalizeRevisionStatus(status = '') {
  const value = safeString(status);

  if (isValidRevisionStatus(value)) return value;

  const text = normalizeText(value);

  const byLabel = Object.entries(REVISION_STATUS).find(
    ([key, label]) =>
      normalizeText(key) === text || normalizeText(label) === text
  );

  return byLabel?.[0] || DEFAULT_REVISION_STATUS;
}

function normalizeResponsable(value = '') {
  const text = safeString(value);

  if (!text) return DEFAULT_RESPONSABLE;

  const found = RESPONSABLES.find(
    (responsable) => normalizeText(responsable) === normalizeText(text)
  );

  return found || text;
}

function normalizeChannel(value = '') {
  const text = normalizeText(value);

  if (!text) return 'otro';

  if (text.includes('whatsapp') || text.includes('wpp') || text.includes('wa')) {
    return 'whatsapp';
  }

  if (text.includes('instagram') || text.includes('ig')) {
    return 'instagram';
  }

  if (text.includes('facebook') || text.includes('fb') || text.includes('meta')) {
    return 'facebook';
  }

  if (text.includes('web') || text.includes('pagina') || text.includes('landing')) {
    return 'web';
  }

  const knownChannel = Object.keys(CHANNELS).find((key) => normalizeText(key) === text);

  return knownChannel || 'otro';
}

function normalizeInterest(value = '') {
  const text = safeString(value);

  if (!text) return INTERESTS.SIN_CLASIFICAR;

  const found = Object.values(INTERESTS).find(
    (interest) => normalizeText(interest) === normalizeText(text)
  );

  return found || text;
}

function toMillis(value) {
  if (!value) return 0;

  if (value instanceof Date) return value.getTime();

  if (value instanceof Timestamp) return value.toMillis();

  if (typeof value?.toMillis === 'function') return value.toMillis();

  if (typeof value === 'number') return value;

  const parsed = new Date(value).getTime();

  return Number.isNaN(parsed) ? 0 : parsed;
}

function toDateInputValue(value) {
  const millis = toMillis(value);

  if (!millis) return '';

  const date = new Date(millis);

  return date.toISOString().slice(0, 10);
}

function formatDateTime(value) {
  const millis = toMillis(value);

  if (!millis) return '';

  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(millis));
}

function createRandomId() {
  if (crypto?.randomUUID) return crypto.randomUUID();

  return `lead_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function cleanFirestoreData(data) {
  if (Array.isArray(data)) {
    return data
      .map((item) => cleanFirestoreData(item))
      .filter((item) => item !== undefined);
  }

  if (data && typeof data === 'object' && !(data instanceof Date) && !(data instanceof Timestamp)) {
    const cleaned = {};

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;

      const cleanedValue = cleanFirestoreData(value);

      if (cleanedValue !== undefined) {
        cleaned[key] = cleanedValue;
      }
    }

    return cleaned;
  }

  return data;
}

function removeReviewFields(data = {}) {
  const cleaned = { ...data };

  for (const field of REVIEW_FIELDS) {
    delete cleaned[field];
  }

  return cleaned;
}

function snapshotToLead(docSnap) {
  const data = docSnap.data() || {};

  return {
    id: docSnap.id,
    ...data,
  };
}

function sortLeadsByRecentActivity(leads = []) {
  return [...leads].sort((a, b) => {
    const aTime =
      toMillis(a.updatedAt) ||
      toMillis(a.lastMessageAt) ||
      toMillis(a.importedAt) ||
      toMillis(a.keybeCreatedAt);

    const bTime =
      toMillis(b.updatedAt) ||
      toMillis(b.lastMessageAt) ||
      toMillis(b.importedAt) ||
      toMillis(b.keybeCreatedAt);

    return bTime - aTime;
  });
}

// ─────────────────────────────────────────────────────────
// Normalización de lead
// ─────────────────────────────────────────────────────────

export function getLeadDocumentId(lead = {}) {
  const phoneNormalized =
    normalizePhone(lead.phoneNormalized) ||
    normalizePhone(lead.phone) ||
    normalizePhone(lead.celular) ||
    normalizePhone(lead.telefono);

  if (phoneNormalized) return phoneNormalized;

  const keybeUuid =
    safeString(lead.keybeUuid) ||
    safeString(lead.uuid) ||
    safeString(lead.idKeybe) ||
    safeString(lead.id);

  if (keybeUuid) return keybeUuid;

  return createRandomId();
}

export function normalizeLeadForFirestore(lead = {}, options = {}) {
  const { userProfile = null, isNew = true } = options;

  const phoneNormalized =
    normalizePhone(lead.phoneNormalized) ||
    normalizePhone(lead.phone) ||
    normalizePhone(lead.celular) ||
    normalizePhone(lead.telefono);

  const fullName =
    safeString(lead.fullName) ||
    safeString(lead.name) ||
    safeString(lead.nombre) ||
    safeString(lead.contactName) ||
    'Sin nombre';

  const email =
    normalizeEmail(lead.email) ||
    normalizeEmail(lead.correo) ||
    normalizeEmail(lead.mail);

  const revisionStatus = normalizeRevisionStatus(lead.revisionStatus);
  const assignedTo = normalizeResponsable(lead.assignedTo);

  const normalized = {
    fullName,
    phone: safeString(lead.phone || lead.celular || lead.telefono || ''),
    phoneNormalized,
    email,

    channel: normalizeChannel(lead.channel || lead.canal),
    keybeUuid: safeString(lead.keybeUuid || lead.uuid || lead.idKeybe || ''),
    keybeCreatedAt: lead.keybeCreatedAt || lead.createdAtKeybe || lead.createdAt || null,

    interest: normalizeInterest(lead.interest || lead.interes || lead.category),
    revisionStatus,
    inOfficialBase: normalizeBooleanOrNull(lead.inOfficialBase),

    assignedTo,
    internalNote: safeString(lead.internalNote || lead.note || lead.nota || ''),

    messageCount: Number(lead.messageCount || lead.totalMessages || 0),
    lastMessage: safeString(lead.lastMessage || lead.ultimoMensaje || ''),
    lastMessageAt: lead.lastMessageAt || lead.ultimoMensajeFecha || null,

    source: safeString(lead.source || SOURCE_KEYBE),
    importedAt: lead.importedAt || serverTimestamp(),
    importedBy: safeString(lead.importedBy || userProfile?.email || ''),
    updatedAt: serverTimestamp(),
  };

  if (isNew) {
    normalized.createdAt = serverTimestamp();

    if (!normalized.revisionStatus) {
      normalized.revisionStatus = DEFAULT_REVISION_STATUS;
    }

    if (!normalized.assignedTo) {
      normalized.assignedTo = DEFAULT_RESPONSABLE;
    }

    if (normalized.inOfficialBase === undefined) {
      normalized.inOfficialBase = null;
    }
  }

  return cleanFirestoreData(normalized);
}

// ─────────────────────────────────────────────────────────
// Lectura de contactos
// ─────────────────────────────────────────────────────────

export async function loadLeads(options = {}) {
  const {
    updateState = true,
    useOrderBy = true,
  } = options;

  try {
    const leadsRef = collection(db, LEADS_COLLECTION);

    let snapshot;

    try {
      if (useOrderBy) {
        const q = query(leadsRef, orderBy('updatedAt', 'desc'));
        snapshot = await getDocs(q);
      } else {
        snapshot = await getDocs(leadsRef);
      }
    } catch (error) {
      console.warn(
        '[leads.service] Falló lectura con orderBy. Se intenta lectura simple:',
        error
      );

      snapshot = await getDocs(leadsRef);
    }

    const leads = snapshot.docs.map(snapshotToLead);
    const sortedLeads = sortLeadsByRecentActivity(leads);

    if (updateState) {
      const filters = getState('filters');
      const filteredLeads = filterLeads(sortedLeads, filters);

      setState({
        allLeads: sortedLeads,
        filteredLeads,
        currentPage: 1,
      });
    }

    return sortedLeads;
  } catch (error) {
    console.error('[leads.service] Error cargando contactos:', error);

    throw new LeadsServiceError(
      'No fue posible cargar los contactos desde Firestore.',
      error?.code || 'leads/load-failed'
    );
  }
}

export async function getLeadById(leadId) {
  const id = safeString(leadId);

  if (!id) {
    throw new LeadsServiceError('No se recibió el ID del contacto.', 'leads/missing-id');
  }

  try {
    const leadRef = doc(db, LEADS_COLLECTION, id);
    const leadSnap = await getDoc(leadRef);

    if (!leadSnap.exists()) {
      throw new LeadsServiceError(
        'No se encontró este contacto.',
        'leads/not-found'
      );
    }

    return snapshotToLead(leadSnap);
  } catch (error) {
    if (error instanceof LeadsServiceError) throw error;

    console.error('[leads.service] Error leyendo contacto:', error);

    throw new LeadsServiceError(
      'No fue posible leer el contacto seleccionado.',
      error?.code || 'leads/read-failed'
    );
  }
}

// ─────────────────────────────────────────────────────────
// Escritura / actualización
// ─────────────────────────────────────────────────────────

export async function saveLeadReview(leadId, updates = {}, userProfile = null) {
  const id = safeString(leadId);

  if (!id) {
    throw new LeadsServiceError('No se recibió el ID del contacto.', 'leads/missing-id');
  }

  const payload = {
    revisionStatus:
      updates.revisionStatus !== undefined
        ? normalizeRevisionStatus(updates.revisionStatus)
        : undefined,

    inOfficialBase:
      updates.inOfficialBase !== undefined
        ? normalizeBooleanOrNull(updates.inOfficialBase)
        : undefined,

    assignedTo:
      updates.assignedTo !== undefined
        ? normalizeResponsable(updates.assignedTo)
        : undefined,

    internalNote:
      updates.internalNote !== undefined
        ? safeString(updates.internalNote)
        : undefined,

    reviewedBy: userProfile?.email || '',
    reviewedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const cleanedPayload = cleanFirestoreData(payload);

  try {
    const leadRef = doc(db, LEADS_COLLECTION, id);

    await updateDoc(leadRef, cleanedPayload);

    const updatedLead = await getLeadById(id);

    updateLeadInState(updatedLead);

    return updatedLead;
  } catch (error) {
    console.error('[leads.service] Error guardando revisión:', error);

    throw new LeadsServiceError(
      'No fue posible guardar la revisión del contacto.',
      error?.code || 'leads/update-review-failed'
    );
  }
}

export async function updateLead(leadId, updates = {}, userProfile = null) {
  const id = safeString(leadId);

  if (!id) {
    throw new LeadsServiceError('No se recibió el ID del contacto.', 'leads/missing-id');
  }

  const payload = {
    ...updates,
    updatedBy: userProfile?.email || '',
    updatedAt: serverTimestamp(),
  };

  const cleanedPayload = cleanFirestoreData(payload);

  try {
    const leadRef = doc(db, LEADS_COLLECTION, id);

    await updateDoc(leadRef, cleanedPayload);

    const updatedLead = await getLeadById(id);

    updateLeadInState(updatedLead);

    return updatedLead;
  } catch (error) {
    console.error('[leads.service] Error actualizando contacto:', error);

    throw new LeadsServiceError(
      'No fue posible actualizar el contacto.',
      error?.code || 'leads/update-failed'
    );
  }
}

export async function upsertLeadFromImport(lead = {}, userProfile = null) {
  const id = getLeadDocumentId(lead);
  const leadRef = doc(db, LEADS_COLLECTION, id);

  try {
    const existingSnap = await getDoc(leadRef);
    const isNew = !existingSnap.exists();

    let payload = normalizeLeadForFirestore(lead, {
      userProfile,
      isNew,
    });

    // Si ya existe, NO pisamos la revisión humana.
    // Importar varias veces no debe borrar “ya está en base”, notas, etc.
    if (!isNew) {
      payload = removeReviewFields(payload);
      payload.reimportedAt = serverTimestamp();
      payload.reimportedBy = userProfile?.email || '';
    }

    await setDoc(leadRef, cleanFirestoreData(payload), { merge: true });

    return {
      id,
      status: isNew ? 'created' : 'updated',
    };
  } catch (error) {
    console.error('[leads.service] Error haciendo upsert de contacto:', error, lead);

    throw new LeadsServiceError(
      `No fue posible guardar el contacto ${lead.fullName || lead.phone || id}.`,
      error?.code || 'leads/upsert-failed'
    );
  }
}

export async function upsertLeadsFromImport(leads = [], options = {}) {
  const {
    userProfile = null,
    importMeta = {},
    onProgress = null,
  } = options;

  if (!Array.isArray(leads)) {
    throw new LeadsServiceError(
      'Los contactos importados deben llegar como una lista.',
      'leads/invalid-import-data'
    );
  }

  const summary = {
    total: leads.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    errorDetails: [],
  };

  for (let index = 0; index < leads.length; index += 1) {
    const lead = leads[index];

    try {
      const id = getLeadDocumentId(lead);

      if (!id) {
        summary.skipped += 1;
        continue;
      }

      const result = await upsertLeadFromImport(
        {
          ...lead,
          importedBy: userProfile?.email || '',
        },
        userProfile
      );

      if (result.status === 'created') summary.created += 1;
      if (result.status === 'updated') summary.updated += 1;
    } catch (error) {
      summary.errors += 1;

      summary.errorDetails.push({
        index,
        lead,
        message: error?.message || 'Error desconocido',
      });
    }

    onProgress?.({
      ...summary,
      current: index + 1,
      percent: leads.length
        ? Math.round(((index + 1) / leads.length) * 100)
        : 100,
    });
  }

  await createImportLog({
    ...importMeta,
    totalProcessed: summary.total,
    totalCreated: summary.created,
    totalUpdated: summary.updated,
    totalSkipped: summary.skipped,
    totalErrors: summary.errors,
    createdBy: userProfile?.email || '',
  });

  await loadLeads({ updateState: true });

  return summary;
}

export async function createImportLog(data = {}) {
  try {
    const importsRef = collection(db, IMPORTS_COLLECTION);

    const payload = cleanFirestoreData({
      fileContactsName: safeString(data.fileContactsName || ''),
      fileMessagesName: safeString(data.fileMessagesName || ''),
      totalContacts: Number(data.totalContacts || 0),
      totalMessages: Number(data.totalMessages || 0),
      totalProcessed: Number(data.totalProcessed || 0),
      totalCreated: Number(data.totalCreated || 0),
      totalUpdated: Number(data.totalUpdated || 0),
      totalSkipped: Number(data.totalSkipped || 0),
      totalErrors: Number(data.totalErrors || 0),
      createdBy: safeString(data.createdBy || ''),
      createdAt: serverTimestamp(),
    });

    const docRef = await addDoc(importsRef, payload);

    return {
      id: docRef.id,
      ...payload,
    };
  } catch (error) {
    console.warn(
      '[leads.service] No se pudo crear historial de importación. No bloquea el proceso:',
      error
    );

    return null;
  }
}

// ─────────────────────────────────────────────────────────
// Estado local
// ─────────────────────────────────────────────────────────

export function updateLeadInState(updatedLead) {
  if (!updatedLead?.id) return;

  const allLeads = getState('allLeads') || [];

  const nextAllLeads = allLeads.map((lead) =>
    lead.id === updatedLead.id ? { ...lead, ...updatedLead } : lead
  );

  const filters = getState('filters');
  const filteredLeads = filterLeads(nextAllLeads, filters);

  setState({
    allLeads: sortLeadsByRecentActivity(nextAllLeads),
    filteredLeads,
    currentLead: updatedLead,
  });
}

export function setCurrentLead(lead) {
  setState({
    currentLead: lead || null,
    currentView: lead ? 'lead-detail' : 'leads',
  });
}

export function refreshFilteredLeads() {
  const allLeads = getState('allLeads') || [];
  const filters = getState('filters') || {};

  const filteredLeads = filterLeads(allLeads, filters);

  setState({
    filteredLeads,
    currentPage: 1,
  });

  return filteredLeads;
}

// ─────────────────────────────────────────────────────────
// Filtros y paginación
// ─────────────────────────────────────────────────────────

export function filterLeads(leads = [], filters = {}) {
  const search = normalizeText(filters.search || '');
  const status = safeString(filters.status || '');
  const assigned = safeString(filters.assigned || '');
  const channel = safeString(filters.channel || '');
  const interest = safeString(filters.interest || '');

  return leads.filter((lead) => {
    if (status && lead.revisionStatus !== status) return false;
    if (assigned && lead.assignedTo !== assigned) return false;
    if (channel && lead.channel !== channel) return false;
    if (interest && lead.interest !== interest) return false;

    if (!search) return true;

    const haystack = SEARCHABLE_FIELDS
      .map((field) => normalizeText(lead[field] || ''))
      .join(' ');

    return haystack.includes(search);
  });
}

export function getPaginatedLeads(leads = null, page = null, pageSize = PAGE_SIZE) {
  const sourceLeads = leads || getState('filteredLeads') || [];
  const currentPage = Number(page || getState('currentPage') || 1);

  const totalItems = sourceLeads.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  const safePage = Math.min(Math.max(currentPage, 1), totalPages);

  const start = (safePage - 1) * pageSize;
  const end = start + pageSize;

  return {
    items: sourceLeads.slice(start, end),
    page: safePage,
    pageSize,
    totalItems,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
  };
}

// ─────────────────────────────────────────────────────────
// Dashboard / métricas
// ─────────────────────────────────────────────────────────

export function getLeadStats(leads = null) {
  const sourceLeads = leads || getState('allLeads') || [];

  const stats = {
    total: sourceLeads.length,
    byStatus: {},
    byChannel: {},
    byInterest: {},
    byAssigned: {},
    inOfficialBase: 0,
    notInOfficialBase: 0,
    unknownOfficialBase: 0,
    pendingReview: 0,
    withMessages: 0,
    withoutMessages: 0,
    lastImportedAt: null,
    lastUpdatedAt: null,
  };

  for (const lead of sourceLeads) {
    const status = lead.revisionStatus || DEFAULT_REVISION_STATUS;
    const channel = lead.channel || 'otro';
    const interest = lead.interest || INTERESTS.SIN_CLASIFICAR;
    const assigned = lead.assignedTo || DEFAULT_RESPONSABLE;

    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    stats.byChannel[channel] = (stats.byChannel[channel] || 0) + 1;
    stats.byInterest[interest] = (stats.byInterest[interest] || 0) + 1;
    stats.byAssigned[assigned] = (stats.byAssigned[assigned] || 0) + 1;

    if (lead.inOfficialBase === true) stats.inOfficialBase += 1;
    else if (lead.inOfficialBase === false) stats.notInOfficialBase += 1;
    else stats.unknownOfficialBase += 1;

    if (status === DEFAULT_REVISION_STATUS) stats.pendingReview += 1;

    if (Number(lead.messageCount || 0) > 0 || safeString(lead.lastMessage)) {
      stats.withMessages += 1;
    } else {
      stats.withoutMessages += 1;
    }

    const importedAt = toMillis(lead.importedAt);
    const updatedAt = toMillis(lead.updatedAt);

    if (importedAt && importedAt > toMillis(stats.lastImportedAt)) {
      stats.lastImportedAt = lead.importedAt;
    }

    if (updatedAt && updatedAt > toMillis(stats.lastUpdatedAt)) {
      stats.lastUpdatedAt = lead.updatedAt;
    }
  }

  return stats;
}

export function getReadableStats(leads = null) {
  const stats = getLeadStats(leads);

  return {
    ...stats,
    lastImportedAtLabel: formatDateTime(stats.lastImportedAt),
    lastUpdatedAtLabel: formatDateTime(stats.lastUpdatedAt),
  };
}

// ─────────────────────────────────────────────────────────
// Exportación CSV
// ─────────────────────────────────────────────────────────

function escapeCsvCell(value) {
  const text = safeString(value);

  if (
    text.includes(';') ||
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\n')
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function leadsToCsv(leads = null) {
  const sourceLeads = leads || getState('filteredLeads') || [];

  const headers = [
    'Nombre',
    'Teléfono',
    'Teléfono normalizado',
    'Correo',
    'Canal',
    'Interés',
    'Estado revisión',
    'Está en base oficial',
    'Responsable',
    'Nota interna',
    'Cantidad mensajes',
    'Último mensaje',
    'Fecha último mensaje',
    'Importado por',
    'Fecha importación',
    'Revisado por',
    'Fecha revisión',
  ];

  const rows = sourceLeads.map((lead) => [
    lead.fullName,
    lead.phone,
    lead.phoneNormalized,
    lead.email,
    CHANNELS[lead.channel] || lead.channel,
    lead.interest,
    REVISION_STATUS[lead.revisionStatus] || lead.revisionStatus,
    lead.inOfficialBase === true
      ? 'Sí'
      : lead.inOfficialBase === false
        ? 'No'
        : 'Sin revisar',
    lead.assignedTo,
    lead.internalNote,
    lead.messageCount,
    lead.lastMessage,
    formatDateTime(lead.lastMessageAt),
    lead.importedBy,
    formatDateTime(lead.importedAt),
    lead.reviewedBy,
    formatDateTime(lead.reviewedAt),
  ]);

  const csvLines = [
    headers.map(escapeCsvCell).join(';'),
    ...rows.map((row) => row.map(escapeCsvCell).join(';')),
  ];

  return csvLines.join('\n');
}

export function downloadLeadsCsv(leads = null, filename = '') {
  const csv = leadsToCsv(leads);
  const blob = new Blob([`\uFEFF${csv}`], {
    type: 'text/csv;charset=utf-8;',
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  const date = new Date().toISOString().slice(0, 10);
  const safeFilename = filename || `contactos-keybe-musicala-${date}.csv`;

  link.href = url;
  link.download = safeFilename;
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────
// Helpers públicos para UI
// ─────────────────────────────────────────────────────────

export function getLeadStatusLabel(status) {
  return REVISION_STATUS[status] || 'Sin estado';
}

export function getChannelLabel(channel) {
  return CHANNELS[channel] || 'Otro';
}

export function getOfficialBaseLabel(value) {
  if (value === true) return 'Sí está en base oficial';
  if (value === false) return 'No está en base oficial';
  return 'Sin revisar';
}

export function getLeadDateLabel(value) {
  return formatDateTime(value);
}

export function getLeadDateInputValue(value) {
  return toDateInputValue(value);
}

export function parseLeadsServiceError(error) {
  if (error instanceof LeadsServiceError) {
    return error.message;
  }

  return error?.message || 'Ocurrió un error gestionando los contactos.';
}