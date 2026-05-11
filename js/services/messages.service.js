// messages.service.js - Conversaciones completas por lead Keybe.

import {
  collection, doc, getDocs, setDoc, deleteDoc,
  query, orderBy, serverTimestamp,
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

  for (const msg of cleanMessages) {
    const messageId = msg.id || `msg_${String(msg.order ?? Date.now()).padStart(5, '0')}`;
    try {
      await setDoc(doc(db, COLLECTIONS.KEYBE_LEADS, leadId, COLLECTIONS.LEAD_MESSAGES, messageId), {
        ...msg,
        importedAt: serverTimestamp(),
      }, { merge: true });
      saved++;
    } catch (err) {
      console.error('No se pudo guardar mensaje Keybe', { leadId, messageId, err });
      omitted++;
    }
  }

  return { saved, omitted };
}

export async function getLeadMessages(leadId) {
  const snap = await getDocs(query(messagesRef(leadId), orderBy('order', 'asc')));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const oa = Number.isFinite(a.order) ? a.order : 0;
      const ob = Number.isFinite(b.order) ? b.order : 0;
      return oa - ob;
    });
}
