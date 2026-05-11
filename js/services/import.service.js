// import.service.js - Orquestador de importacion Keybe con auditoria.

import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { readExcelFile, validateColumns, normalizeRowKeys } from '../utils/excel.utils.js';
import { normalizePhone } from '../utils/phone.utils.js';
import { detectInterest, detectInterestTags } from '../utils/interest.utils.js';
import { batchUpsertLeads, saveImportBatch, upsertUnlinkedConversations } from './firestore.service.js';
import { upsertLeadMessages } from './messages.service.js';
import { SOURCE_KEYBE } from '../utils/constants.js';

const CONTACTS_REQUIRED = ['phone'];
const MESSAGES_REQUIRED = ['text'];

export async function parseContactsFile(file) {
  const rows = await readExcelFile(file);
  if (!rows.length) throw new Error('El archivo de contactos esta vacio.');
  const normalized = rows.map((row, i) => ({ ...normalizeRowKeys(row), __originalRow: row, __rowIndex: i + 2 }));
  const { valid, missing } = validateColumns(normalized, CONTACTS_REQUIRED);
  if (!valid) throw new Error(`Al archivo de contactos le faltan columnas: ${missing.join(', ')}`);
  return normalized;
}

export async function parseMessagesFile(file) {
  const rows = await readExcelFile(file);
  if (!rows.length) throw new Error('El archivo de mensajes esta vacio.');
  const normalized = rows.map((row, i) => ({ ...normalizeRowKeys(row), __originalRow: row, __rowIndex: i + 2 }));
  const { valid, missing } = validateColumns(normalized, MESSAGES_REQUIRED);
  if (!valid) throw new Error(`Al archivo de mensajes le faltan columnas: ${missing.join(', ')}`);
  return normalized;
}

export function processImportData(contactRows, messageRows) {
  const importBatchId = `keybe_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const importedAt = new Date();
  const contactMap = new Map();
  const contactsWithoutPhone = [];
  let recoveredPhones = 0;

  contactRows.forEach((row) => {
    const phoneInfo = normalizePhone(row.phone);
    if (phoneInfo.recoveredFromScientificNotation) recoveredPhones++;
    const enriched = { ...row, __phoneInfo: phoneInfo };
    if (!phoneInfo.isValidPhone) {
      contactsWithoutPhone.push(enriched);
      return;
    }
    if (!contactMap.has(phoneInfo.local)) contactMap.set(phoneInfo.local, []);
    contactMap.get(phoneInfo.local).push(enriched);
  });

  const messages = messageRows.map((row) => enrichMessage(row, importBatchId));
  recoveredPhones += messages.filter((m) => m.userPhoneInfo.recoveredFromScientificNotation || m.userHostPhoneInfo.recoveredFromScientificNotation).length;

  const messagesByPhone = new Map();
  const unlinkedMessages = [];
  for (const msg of messages) {
    const key = shouldLinkByPhone(msg) ? (msg.userPhoneInfo.local || msg.userHostPhoneInfo.local) : '';
    if (key && contactMap.has(key)) {
      if (!messagesByPhone.has(key)) messagesByPhone.set(key, []);
      messagesByPhone.get(key).push(msg);
    } else {
      unlinkedMessages.push(msg);
    }
  }

  const leads = [];
  let duplicateGroups = 0;
  let duplicateMergedRows = 0;
  let associatedMessages = 0;
  let dateErrors = 0;

  for (const [phone, rows] of contactMap.entries()) {
    const orderedRows = [...rows].sort((a, b) => qualityScore(b) - qualityScore(a));
    const baseRow = orderedRows[0];
    const msgs = (messagesByPhone.get(phone) || []).sort((a, b) => a.createdAtMs - b.createdAtMs);
    associatedMessages += msgs.length;
    dateErrors += msgs.filter((m) => !m.createdAtMs && m.createdAtRaw).length;

    const isDuplicate = rows.length > 1;
    if (isDuplicate) {
      duplicateGroups++;
      duplicateMergedRows += rows.length - 1;
    }

    const texts = msgs.map((m) => m.text).filter(Boolean);
    const lastMsg = msgs[msgs.length - 1] || null;
    const name = String(baseRow.name || '').trim();
    const surname = String(baseRow.surname || '').trim();
    const fullName = [name, surname].filter(Boolean).join(' ') || '(Sin nombre)';
    const channel = detectMainChannel(msgs);
    const tagsDetected = detectInterestTags(texts);

    leads.push({
      source: SOURCE_KEYBE,
      importBatchId,
      keybeContactUuid: String(baseRow.uuid || '').trim() || null,
      uuid: String(baseRow.uuid || '').trim() || null,
      typeEntity: String(baseRow.typeentity || '').trim() || null,
      name,
      surname,
      fullName,
      phone,
      phoneNormalized: phone,
      phoneE164: `+57${phone}`,
      phoneRaw: String(baseRow.phone ?? '').trim(),
      email: String(baseRow.email || '').trim().toLowerCase(),
      keybeCreatedAt: toDateOrNull(baseRow.createdat || baseRow.createdAt),
      importedAt,
      channel,
      lastMessage: lastMsg ? lastMsg.text.slice(0, 500) : '',
      lastMessageAt: lastMsg?.createdAt || null,
      messageCount: msgs.length,
      hasFullConversation: msgs.length > 0,
      possibleInterest: detectInterest(texts),
      possibleInterests: tagsDetected,
      tagsDetected,
      revisionStatus: 'pendiente_revision',
      isDuplicate,
      possibleDuplicate: isDuplicate,
      duplicateCount: rows.length,
      duplicateRowsSummary: {
        totalRows: rows.length,
        mergedRows: Math.max(rows.length - 1, 0),
        rowIndexes: rows.map((r) => r.__rowIndex),
        names: rows.map((r) => [r.name, r.surname].filter(Boolean).join(' ').trim()).filter(Boolean).slice(0, 8),
      },
      isInOfficialDatabase: null,
      assignedTo: 'Sin asignar',
      internalNote: '',
      reviewedBy: null,
      reviewedByEmail: null,
      reviewedAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      dataQuality: {
        hasValidPhone: true,
        hasEmail: Boolean(baseRow.email),
        hasName: Boolean(name || surname),
        hasMessages: msgs.length > 0,
        phoneWasRecoveredFromScientificNotation: Boolean(baseRow.__phoneInfo?.recoveredFromScientificNotation),
        possibleDuplicate: isDuplicate,
        linkedAutomatically: msgs.length > 0,
      },
      importMetrics: {
        sourceRows: rows.length,
        contactRowIndexes: rows.map((r) => r.__rowIndex),
        messageRowsAssociated: msgs.length,
      },
      originalRow: baseRow.__originalRow,
      allOriginalFields: rows.map((r) => r.__originalRow),
      _messages: msgs.map((msg, index) => buildLeadMessage(phone, msg, index)),
    });
  }

  const unlinkedConversations = buildUnlinkedConversations(unlinkedMessages, importBatchId);
  const messageChannels = countBy(messages, (m) => m.channel);
  const conversations = buildConversationKeys(messages).size;
  const unlinkedConversationCount = unlinkedConversations.length;
  const messagesWithValidPhone = messages.filter((m) => m.userPhoneInfo.isValidPhone || m.userHostPhoneInfo.isValidPhone).length;
  const messagesWithoutRealPhone = messages.length - messagesWithValidPhone;
  dateErrors += contactRows.filter((r) => (r.createdat || r.createdAt) && !toDateOrNull(r.createdat || r.createdAt)).length;

  const stats = {
    importBatchId,
    importedAt: importedAt.toISOString(),
    totalContactRows: contactRows.length,
    totalMessageRows: messageRows.length,
    uniqueImportableContacts: leads.length,
    contactsWithValidPhone: Array.from(contactMap.values()).reduce((sum, rows) => sum + rows.length, 0),
    contactsWithoutPhone: contactsWithoutPhone.length,
    contactRowsWithoutPhone: contactsWithoutPhone.length,
    contactsWithEmail: contactRows.filter((r) => String(r.email || '').trim()).length,
    duplicateGroups,
    duplicateMergedRows,
    contactsWithMessages: leads.filter((l) => l.messageCount > 0).length,
    contactsWithoutMessages: leads.filter((l) => l.messageCount === 0).length,
    messagesByChannel: messageChannels,
    messagesWithValidPhone,
    messagesWithoutRealPhone,
    messagesAssociableToContact: associatedMessages,
    associatedMessages,
    messagesWithoutContact: unlinkedMessages.length,
    unlinkedMessages: unlinkedMessages.length,
    conversationsDetected: conversations,
    conversationsWithoutContact: unlinkedConversationCount,
    possibleDateErrors: dateErrors,
    phonesRecoveredFromScientificNotation: recoveredPhones,
    omittedContactRows: contactsWithoutPhone.length,
  };

  const diagnostics = {
    stats,
    contactsWithoutPhone: contactsWithoutPhone.map(diagnosticContact),
    unlinkedMessages: unlinkedMessages.slice(0, 2000).map(diagnosticMessage),
    possibleDuplicates: leads.filter((l) => l.isDuplicate).map((l) => ({
      phone: l.phone,
      rowIndexes: l.duplicateRowsSummary.rowIndexes,
      names: l.duplicateRowsSummary.names,
    })),
    suspiciousPhones: [
      ...contactsWithoutPhone.map(diagnosticContact),
      ...messages.filter((m) => m.userPhoneInfo.isPlatformId || m.userHostPhoneInfo.isPlatformId).map(diagnosticMessage),
    ].slice(0, 2000),
    conversationsByChannel: messageChannels,
  };

  return { leads, stats, diagnostics, unlinkedConversations };
}

export async function uploadLeads(leads, onProgress, context = {}) {
  const stats = context.stats || {};
  const importBatchId = stats.importBatchId || leads[0]?.importBatchId || `keybe_${Date.now()}`;
  await saveImportBatch(importBatchId, {
    ...stats,
    diagnosticsSummary: buildDiagnosticsSummary(context.diagnostics),
    status: 'running',
  });
  await batchUpsertLeads(leads, onProgress);
  const messageSummary = await uploadMessagesForLeads(leads, onProgress);
  const unlinkedSummary = await upsertUnlinkedConversations(context.unlinkedConversations || [], onProgress);
  await saveImportBatch(importBatchId, {
    ...stats,
    status: 'completed',
    completedAt: new Date(),
    contactsUpserted: leads.length,
    messagesSaved: messageSummary.saved,
    messagesOmitted: messageSummary.omitted,
    unlinkedConversationsSaved: unlinkedSummary.saved,
  });
  return {
    uploaded: leads.length,
    messagesSaved: messageSummary.saved,
    messagesOmitted: messageSummary.omitted,
    unlinkedConversationsSaved: unlinkedSummary.saved,
  };
}

function buildDiagnosticsSummary(diagnostics) {
  if (!diagnostics) return null;
  return {
    contactsWithoutPhoneCount: diagnostics.contactsWithoutPhone?.length || 0,
    unlinkedMessagesCount: diagnostics.unlinkedMessages?.length || 0,
    possibleDuplicatesCount: diagnostics.possibleDuplicates?.length || 0,
    suspiciousPhonesCount: diagnostics.suspiciousPhones?.length || 0,
    conversationsByChannel: diagnostics.conversationsByChannel || {},
    sampleContactsWithoutPhone: (diagnostics.contactsWithoutPhone || []).slice(0, 20).map(trimDiagnosticItem),
    sampleUnlinkedMessages: (diagnostics.unlinkedMessages || []).slice(0, 20).map(trimDiagnosticItem),
    samplePossibleDuplicates: (diagnostics.possibleDuplicates || []).slice(0, 20),
  };
}

function trimDiagnosticItem(item) {
  return {
    rowIndex: item.rowIndex ?? null,
    name: item.name || '',
    channel: item.channel || '',
    roomId: item.roomId || '',
    phoneRaw: item.phoneRaw || item.userPhoneRaw || '',
    userHost: item.userHost || '',
    reason: item.reason || '',
    text: item.text ? String(item.text).slice(0, 240) : '',
  };
}

function enrichMessage(row, importBatchId) {
  const channel = normalizeChannel(row.channel || row.source || row.typechannel);
  const userPhoneInfo = normalizePhone(row.user_phone || row.userphone || '');
  const userHostPhoneInfo = normalizePhone(row.userhost || row.userHost || '');
  const createdAtRaw = row.createdat || row.createdAt || row.date || row.timestamp || '';
  const createdAt = toDateOrNull(createdAtRaw);
  const text = String(row.text || row.message || row.body || '').trim();

  return {
    ...row,
    importBatchId,
    channel,
    text,
    createdAt,
    createdAtMs: createdAt ? createdAt.getTime() : 0,
    createdAtRaw,
    roomId: String(row.roomid || row.roomId || '').trim(),
    sender: String(row.sender || row.author || row.agent || '').trim(),
    type: String(row.type || row.direction || '').trim(),
    userPhoneRaw: String(row.user_phone || row.userphone || '').trim(),
    userHostRaw: String(row.userhost || row.userHost || '').trim(),
    userPhoneInfo,
    userHostPhoneInfo,
    originalRow: row.__originalRow || compactRaw(row),
    sourceRowIndex: row.__rowIndex,
  };
}

function shouldLinkByPhone(msg) {
  if (!['whatsapp', 'keybe_wp', 'keybe wp'].includes(msg.channel)) return false;
  return msg.userPhoneInfo.isValidPhone || msg.userHostPhoneInfo.isValidPhone;
}

function buildLeadMessage(phone, msg, index) {
  return {
    id: stableMessageId(msg),
    order: index,
    rowIndex: msg.sourceRowIndex ?? null,
    phone,
    phoneRaw: msg.userPhoneRaw,
    user_phone: msg.userPhoneRaw,
    userPhoneRaw: msg.userPhoneRaw,
    userPhoneNormalized: msg.userPhoneInfo.local || '',
    text: msg.text,
    type: msg.type,
    createdAt: msg.createdAt,
    channel: msg.channel,
    sender: msg.sender,
    roomId: msg.roomId,
    userHost: msg.userHostRaw,
    direction: classifySpeaker(msg),
    author: msg.sender || null,
    linkedContactId: phone,
    isLinked: true,
    source: SOURCE_KEYBE,
    importBatchId: msg.importBatchId,
    originalRow: msg.originalRow,
    raw: compactRaw(msg.originalRow),
  };
}

function buildUnlinkedConversations(messages, importBatchId) {
  const groups = new Map();
  for (const msg of messages) {
    const key = conversationKey(msg);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(msg);
  }
  return Array.from(groups.entries()).map(([key, msgs]) => {
    const sorted = msgs.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return {
      id: key,
      source: SOURCE_KEYBE,
      importBatchId,
      channel: sorted[0]?.channel || 'otro',
      roomId: sorted[0]?.roomId || '',
      userPhoneRaw: sorted[0]?.userPhoneRaw || '',
      userHost: sorted[0]?.userHostRaw || '',
      messageCount: sorted.length,
      firstMessageAt: sorted[0]?.createdAt || null,
      lastMessageAt: sorted[sorted.length - 1]?.createdAt || null,
      reason: 'no_contact_phone_match',
      messagePreview: sorted.slice(0, 25).map((m, i) => compactUnlinkedMessage(m, i)),
      omittedPreviewMessages: Math.max(sorted.length - 25, 0),
      updatedAt: serverTimestamp(),
      importedAt: serverTimestamp(),
    };
  });
}

function compactUnlinkedMessage(msg, index) {
  return {
    id: stableMessageId(msg),
    order: index,
    rowIndex: msg.sourceRowIndex ?? null,
    text: msg.text ? msg.text.slice(0, 1000) : '',
    type: msg.type,
    createdAt: msg.createdAt,
    channel: msg.channel,
    sender: msg.sender,
    roomId: msg.roomId,
    userPhoneRaw: msg.userPhoneRaw,
    userHost: msg.userHostRaw,
    reason: msg.userPhoneInfo.reason || msg.userHostPhoneInfo.reason,
  };
}

function stableMessageId(msg) {
  const base = [
    msg.channel,
    msg.roomId || msg.userPhoneRaw || msg.userHostRaw,
    msg.createdAtRaw || msg.createdAtMs || '',
    msg.sender,
    hashText(msg.text),
  ].join('|');
  return `msg_${hashText(base)}`;
}

function conversationKey(msg) {
  return `conv_${hashText([msg.channel, msg.roomId, msg.userPhoneRaw, msg.userHostRaw].filter(Boolean).join('|') || stableMessageId(msg))}`;
}

function buildConversationKeys(messages) {
  return new Set(messages.map(conversationKey));
}

function normalizeChannel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.includes('wp') || raw.includes('whatsapp')) return raw.includes('keybe') ? 'keybe_wp' : 'whatsapp';
  if (raw.includes('instagram') || raw === 'ig') return 'instagram';
  if (raw.includes('facebook') || raw.includes('messenger') || raw === 'fb') return 'facebook';
  if (raw.includes('web')) return 'web';
  return raw || 'otro';
}

function classifySpeaker(msg) {
  const text = `${msg.type} ${msg.sender}`.toLowerCase();
  if (text.includes('bot')) return 'bot';
  if (text.includes('system') || text.includes('sistema')) return 'system';
  if (text.includes('advisor') || text.includes('agent') || text.includes('asesor') || text.includes('host')) return 'advisor';
  if (text.includes('user') || text.includes('cliente') || text.includes('inbound')) return 'user';
  if (text.includes('out')) return 'advisor';
  if (text.includes('in')) return 'user';
  return 'desconocido';
}

function detectMainChannel(msgs) {
  if (!msgs.length) return 'otro';
  const counts = countBy(msgs, (msg) => msg.channel || 'otro');
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'otro';
}

async function uploadMessagesForLeads(leads, onProgress) {
  const leadsWithMessages = leads.filter((lead) => lead._messages?.length);
  const total = leadsWithMessages.length;
  let done = 0;
  let saved = 0;
  let omitted = 0;

  for (const lead of leadsWithMessages) {
    const res = await upsertLeadMessages(lead.phone, lead._messages);
    saved += res.saved;
    omitted += res.omitted;
    done++;
    const pct = total ? Math.round((done / total) * 100) : 100;
    onProgress?.(pct, `Guardando conversaciones... ${done} de ${total}`);
  }

  return { saved, omitted };
}

function toDateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    if (value > 20000 && value < 80000) return new Date(excelEpoch.getTime() + value * 86400000);
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function qualityScore(row) {
  return (row.name ? 2 : 0) + (row.surname ? 1 : 0) + (row.email ? 2 : 0) + (row.createdat ? 1 : 0);
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item) || 'otro';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function hashText(text) {
  let hash = 5381;
  const str = String(text || '');
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

function compactRaw(row) {
  const clean = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (key.startsWith('__')) continue;
    clean[key] = value instanceof Date ? value.toISOString() : value;
  }
  return clean;
}

function diagnosticContact(row) {
  return {
    rowIndex: row.__rowIndex,
    name: [row.name, row.surname].filter(Boolean).join(' '),
    phoneRaw: row.phone,
    reason: row.__phoneInfo?.reason,
    originalRow: row.__originalRow,
  };
}

function diagnosticMessage(msg) {
  return {
    rowIndex: msg.sourceRowIndex,
    channel: msg.channel,
    roomId: msg.roomId,
    userPhoneRaw: msg.userPhoneRaw,
    userHost: msg.userHostRaw,
    reason: msg.userPhoneInfo.reason || msg.userHostPhoneInfo.reason,
    text: msg.text,
  };
}
