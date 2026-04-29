// import.service.js - Orquestador de importacion Keybe.
// Lee Excel localmente, consolida por telefono y sube leads + mensajes.

import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { readExcelFile, validateColumns, normalizeRowKeys } from '../utils/excel.utils.js';
import { normalizePhone } from '../utils/phone.utils.js';
import { detectInterest } from '../utils/interest.utils.js';
import { batchUpsertLeads } from './firestore.service.js';
import { replaceLeadMessages } from './messages.service.js';
import { SOURCE_KEYBE } from '../utils/constants.js';

const CONTACTS_REQUIRED = ['name', 'phone'];
const MESSAGES_REQUIRED = ['user_phone', 'text'];

export async function parseContactsFile(file) {
  const rows = await readExcelFile(file);
  if (!rows.length) throw new Error('El archivo de contactos esta vacio.');

  const normalized = rows.map(normalizeRowKeys);
  const { valid, missing } = validateColumns(normalized, CONTACTS_REQUIRED);
  if (!valid) throw new Error(`Al archivo de contactos le faltan columnas: ${missing.join(', ')}`);

  return normalized;
}

export async function parseMessagesFile(file) {
  const rows = await readExcelFile(file);
  if (!rows.length) throw new Error('El archivo de mensajes esta vacio.');

  const normalized = rows.map(normalizeRowKeys);
  const { valid, missing } = validateColumns(normalized, MESSAGES_REQUIRED);
  if (!valid) throw new Error(`Al archivo de mensajes le faltan columnas: ${missing.join(', ')}`);

  return normalized;
}

export function processImportData(contactRows, messageRows) {
  const msgByPhone = {};
  let messageRowsWithoutPhone = 0;

  for (const [index, msg] of messageRows.entries()) {
    const phone = normalizePhone(msg.user_phone || msg.userphone || '');
    if (!phone) {
      messageRowsWithoutPhone++;
      continue;
    }

    if (!msgByPhone[phone]) msgByPhone[phone] = [];
    msgByPhone[phone].push({ ...msg, __rowIndex: index + 2, __normalizedPhone: phone });
  }

  const contactMap = {};
  let contactRowsWithoutPhone = 0;

  for (const [index, row] of contactRows.entries()) {
    const phoneRaw = String(row.phone || '').trim();
    const phone = normalizePhone(phoneRaw);

    if (!phone) {
      contactRowsWithoutPhone++;
      continue;
    }

    if (!contactMap[phone]) {
      contactMap[phone] = { phone, phoneRaw, rows: [] };
    }
    contactMap[phone].rows.push({ ...row, __rowIndex: index + 2 });
  }

  const leads = [];
  const phones = Object.keys(contactMap);
  let duplicateGroupCount = 0;
  let duplicateMergedRows = 0;
  let associatedMessageCount = 0;

  for (const phone of phones) {
    const { rows } = contactMap[phone];
    const isDuplicate = rows.length > 1;
    if (isDuplicate) {
      duplicateGroupCount++;
      duplicateMergedRows += rows.length - 1;
    }

    const baseRow = [...rows].sort((a, b) => {
      const ta = parseDate(a.createdat || a.createdAt);
      const tb = parseDate(b.createdat || b.createdAt);
      return tb - ta;
    })[0];

    const msgs = msgByPhone[phone] || [];
    const sortedDescMsgs = [...msgs].sort((a, b) => {
      const ta = parseDate(a.createdat || a.createdAt || a.date || a.timestamp);
      const tb = parseDate(b.createdat || b.createdAt || b.date || b.timestamp);
      return tb - ta;
    });
    const chronologicalMsgs = sortedDescMsgs.slice().reverse();
    associatedMessageCount += sortedDescMsgs.length;

    const lastMsg = sortedDescMsgs[0] || null;
    const lastMsgAt = lastMsg ? parseDate(lastMsg.createdat || lastMsg.createdAt || lastMsg.date || lastMsg.timestamp) : null;
    const channel = detectMainChannel(msgs);
    const allTexts = msgs.map((m) => String(m.text || m.message || m.body || '')).filter(Boolean);
    const possibleInterest = detectInterest(allTexts);

    const name = String(baseRow.name || '').trim();
    const surname = String(baseRow.surname || '').trim();
    const fullName = [name, surname].filter(Boolean).join(' ') || '(Sin nombre)';

    leads.push({
      source: SOURCE_KEYBE,
      keybeContactUuid: String(baseRow.uuid || '').trim() || null,
      name,
      surname,
      fullName,
      phone,
      phoneRaw: String(baseRow.phone || '').trim(),
      email: String(baseRow.email || '').trim().toLowerCase(),
      channel,
      lastMessage: lastMsg ? String(lastMsg.text || lastMsg.message || lastMsg.body || '').trim().slice(0, 500) : '',
      lastMessageAt: lastMsgAt ? new Date(lastMsgAt) : null,
      messageCount: msgs.length,
      hasFullConversation: msgs.length > 0,
      possibleInterest,
      revisionStatus: 'pendiente_revision',
      isDuplicate,
      duplicateCount: rows.length,
      duplicateRowsSummary: {
        totalRows: rows.length,
        mergedRows: Math.max(rows.length - 1, 0),
        rowIndexes: rows.map((r) => r.__rowIndex).filter(Boolean),
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
      importMetrics: {
        sourceRows: rows.length,
        contactRowIndexes: rows.map((r) => r.__rowIndex).filter(Boolean),
        messageRowsAssociated: msgs.length,
      },
      _messages: buildLeadMessages(phone, chronologicalMsgs),
    });
  }

  const stats = {
    totalContactRows: contactRows.length,
    totalMessageRows: messageRows.length,
    uniqueImportableContacts: phones.length,
    contactRowsWithoutPhone,
    omittedContactRows: contactRowsWithoutPhone,
    duplicateGroups: duplicateGroupCount,
    duplicateMergedRows,
    contactsWithMessages: phones.filter((p) => (msgByPhone[p]?.length ?? 0) > 0).length,
    contactsWithoutMessages: phones.filter((p) => !msgByPhone[p]?.length).length,
    associatedMessages: associatedMessageCount,
    messagesWithoutContact: Object.keys(msgByPhone).filter((p) => !contactMap[p]).reduce((sum, p) => sum + msgByPhone[p].length, 0) + messageRowsWithoutPhone,
    messageRowsWithoutPhone,
  };

  return { leads, stats };
}

export async function uploadLeads(leads, onProgress) {
  await batchUpsertLeads(leads, onProgress);
  await uploadMessagesForLeads(leads, onProgress);
  return { uploaded: leads.length };
}

function parseDate(val) {
  if (!val) return 0;
  if (val instanceof Date) return val.getTime();
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function detectMainChannel(msgs) {
  if (!msgs.length) return 'otro';

  const counts = {};
  for (const msg of msgs) {
    const ch = String(msg.channel || msg.source || '').trim().toLowerCase() || 'otro';
    counts[ch] = (counts[ch] || 0) + 1;
  }

  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'otro';
}

async function uploadMessagesForLeads(leads, onProgress) {
  const leadsWithMessages = leads.filter((lead) => lead._messages?.length);
  const total = leadsWithMessages.length;
  let done = 0;

  for (const lead of leadsWithMessages) {
    await replaceLeadMessages(lead.phone, lead._messages);
    done++;
    const pct = total ? Math.round((done / total) * 100) : 100;
    onProgress?.(pct, `Guardando conversaciones... ${done} de ${total}`);
  }
}

function buildLeadMessages(phone, msgs) {
  return msgs.map((msg, index) => {
    const dateMs = parseDate(msg.createdat || msg.createdAt || msg.date || msg.timestamp);
    return {
      id: `msg_${String(index + 1).padStart(5, '0')}`,
      order: index,
      rowIndex: msg.__rowIndex ?? null,
      phone,
      phoneRaw: String(msg.user_phone || msg.userphone || '').trim(),
      text: String(msg.text || msg.message || msg.body || '').trim(),
      createdAt: dateMs ? new Date(dateMs) : null,
      channel: String(msg.channel || msg.source || '').trim().toLowerCase() || 'otro',
      direction: String(msg.direction || msg.type || msg.sent_by || msg.sender_type || '').trim() || null,
      author: String(msg.author || msg.sender || msg.agent || msg.user_name || '').trim() || null,
      raw: compactRaw(msg),
    };
  });
}

function compactRaw(row) {
  const clean = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('__')) continue;
    if (value === undefined || value === null || value === '') continue;
    clean[key] = value instanceof Date ? value.toISOString() : value;
  }
  return clean;
}
