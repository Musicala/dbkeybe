// messages.service.js - Conversaciones completas por lead Keybe.

import {
  collection, doc, getDocs, setDoc, deleteDoc, writeBatch,
  query, orderBy, limit, startAfter, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { db } from '../config/firebase.config.js';
import { COLLECTIONS } from '../utils/constants.js';

function messagesRef(leadId) {
  return collection(db, COLLECTIONS.KEYBE_LEADS, leadId, COLLECTIONS.LEAD_MESSAGES);
}

export async function replaceLeadMessages(leadId, messages) {
  const ref = messagesRef(leadId);
  const existing = await getDocs(ref);
  await Promise.all(existing.docs.map((snap) => deleteDoc(snap.ref)));

  const cleanMessages = (messages || []).filter((msg) => msg.text || msg.createdAt);
  for (const msg of cleanMessages) {
    const messageId = msg.id || `msg_${String(msg.order ?? Date.now()).padStart(5, '0')}`;
    await setDoc(doc(db, COLLECTIONS.KEYBE_LEADS, leadId, COLLECTIONS.LEAD_MESSAGES, messageId), {
      ...msg,
      importedAt: serverTimestamp(),
    });
  }
}

export async function upsertLeadMessages(leadId, messages) {
  const cleanMessages = (messages || []).filter((msg) => msg.text || msg.createdAt);
  let saved = 0;
  let omitted = 0;
  const BATCH_LIMIT = 200;

  for (let i = 0; i < cleanMessages.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    const chunk = cleanMessages.slice(i, i + BATCH_LIMIT);

    for (const msg of chunk) {
      const messageId = msg.id || `msg_${String(msg.order ?? Date.now()).padStart(5, '0')}`;
      const ref = doc(db, COLLECTIONS.KEYBE_LEADS, leadId, COLLECTIONS.LEAD_MESSAGES, messageId);
      batch.set(ref, {
        ...msg,
        importedAt: serverTimestamp(),
      }, { merge: true });
    }

    try {
      await batch.commit();
      saved += chunk.length;
      if (i + BATCH_LIMIT < cleanMessages.length) await sleep(300);
    } catch (err) {
      console.error('No se pudo guardar lote de mensajes Keybe', { leadId, err });
      omitted += chunk.length;
    }
  }

  return { saved, omitted };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getLeadMessagesPage(leadId, options = {}) {
  const pageSize = Number(options.pageSize || 80);
  const clauses = [orderBy('order', 'asc')];
  if (options.cursor) clauses.push(startAfter(options.cursor));
  clauses.push(limit(pageSize + 1));

  const snap = await getDocs(query(messagesRef(leadId), ...clauses));
  const docs = snap.docs.slice(0, pageSize);
  return {
    messages: docs.map((d) => ({ id: d.id, ...d.data() })),
    cursor: docs[docs.length - 1] || null,
    hasMore: snap.docs.length > pageSize,
  };
}

export async function getLeadMessages(leadId) {
  const firstPage = await getLeadMessagesPage(leadId, { pageSize: 80 });
  return firstPage.messages;
}
