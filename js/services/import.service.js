// import.service.js - Orquestador de importacion Keybe con auditoria.

import { collection, doc, documentId, getDocs, getDoc, increment, query, setDoc, serverTimestamp, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from '../config/firebase.config.js';
import { readExcelFile, validateColumns, normalizeRowKeys } from '../utils/excel.utils.js';
import { normalizePhone } from '../utils/phone.utils.js';
import { detectInterest, detectInterestTags } from '../utils/interest.utils.js';
import { calcStats, saveDashboardStats, recalcDashboardStatsFromFirestore, saveImportBatch, upsertLead, upsertUnlinkedConversations } from './firestore.service.js';
import { upsertLeadMessages } from './messages.service.js';
import { COLLECTIONS, SOURCE_KEYBE } from '../utils/constants.js';
import { hashObject, hashText, stableStringify } from '../utils/hash.utils.js';

const CONTACTS_REQUIRED = ['phone'];
const MESSAGES_REQUIRED = ['text'];

// Tope de escrituras a Firestore por DÍA (acumulado entre todas las tandas del mismo día).
// El plan gratuito de Firebase permite 20.000 escrituras/día; usamos 16.000 (80%) para dejar
// margen al uso normal de la app (revisión de contactos, etc.). El contador se guarda en
// Firestore (colección keybeImportRuns) para que el tope se respete aunque cambies de equipo
// o le des "Importar" varias veces el mismo día.
const DEFAULT_DAILY_WRITE_CAP = 16000;

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
  const importBatchId = buildStableImportBatchId('full', contactRows, messageRows);
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

export function processMessagesOnlyData(messageRows) {
  const importBatchId = buildStableImportBatchId('messages_only', [], messageRows);
  const messages = messageRows.map((row) => enrichMessage(row, importBatchId));
  const messagesByPhone = new Map();
  const unlinkedMessages = [];
  let recoveredPhones = messages.filter((m) => m.userPhoneInfo.recoveredFromScientificNotation || m.userHostPhoneInfo.recoveredFromScientificNotation).length;
  let dateErrors = messages.filter((m) => !m.createdAtMs && m.createdAtRaw).length;

  for (const msg of messages) {
    const key = shouldLinkByPhone(msg) ? (msg.userPhoneInfo.local || msg.userHostPhoneInfo.local) : '';
    if (key) {
      if (!messagesByPhone.has(key)) messagesByPhone.set(key, []);
      messagesByPhone.get(key).push(msg);
    } else {
      unlinkedMessages.push(msg);
    }
  }

  const leads = [];
  let associatedMessages = 0;

  for (const [phone, phoneMessages] of messagesByPhone.entries()) {
    const sorted = phoneMessages.sort((a, b) => a.createdAtMs - b.createdAtMs);
    const texts = sorted.map((m) => m.text).filter(Boolean);
    const lastMsg = sorted[sorted.length - 1] || null;
    const tagsDetected = detectInterestTags(texts);
    associatedMessages += sorted.length;

    leads.push({
      source: SOURCE_KEYBE,
      importBatchId,
      phone,
      phoneNormalized: phone,
      phoneE164: `+57${phone}`,
      channel: detectMainChannel(sorted) || 'otro',
      lastMessage: lastMsg ? lastMsg.text.slice(0, 500) : '',
      lastMessageAt: lastMsg?.createdAt || null,
      messageCount: sorted.length,
      hasFullConversation: sorted.length > 0,
      possibleInterest: detectInterest(texts),
      possibleInterests: tagsDetected,
      tagsDetected,
      updatedAt: serverTimestamp(),
      dataQuality: {
        hasMessages: sorted.length > 0,
        linkedAutomatically: sorted.length > 0,
      },
      importMetrics: {
        messageRowsAssociated: sorted.length,
      },
      _messages: sorted.map((msg, index) => buildLeadMessage(phone, msg, index)),
    });
  }

  const unlinkedConversations = buildUnlinkedConversations(unlinkedMessages, importBatchId);
  const messageChannels = countBy(messages, (m) => m.channel);
  const stats = {
    importBatchId,
    importMode: 'messages_only',
    importedAt: new Date().toISOString(),
    totalContactRows: 0,
    totalMessageRows: messageRows.length,
    uniqueImportableContacts: leads.length,
    contactsWithValidPhone: 0,
    contactsWithoutPhone: 0,
    contactRowsWithoutPhone: 0,
    contactsWithEmail: 0,
    duplicateGroups: 0,
    duplicateMergedRows: 0,
    contactsWithMessages: leads.length,
    contactsWithoutMessages: 0,
    messagesByChannel: messageChannels,
    messagesWithValidPhone: messages.filter((m) => m.userPhoneInfo.isValidPhone || m.userHostPhoneInfo.isValidPhone).length,
    messagesWithoutRealPhone: messages.filter((m) => !(m.userPhoneInfo.isValidPhone || m.userHostPhoneInfo.isValidPhone)).length,
    messagesAssociableToContact: associatedMessages,
    associatedMessages,
    messagesWithoutContact: unlinkedMessages.length,
    unlinkedMessages: unlinkedMessages.length,
    conversationsDetected: buildConversationKeys(messages).size,
    conversationsWithoutContact: unlinkedConversations.length,
    possibleDateErrors: dateErrors,
    phonesRecoveredFromScientificNotation: recoveredPhones,
    omittedContactRows: 0,
    missingExistingLeads: 0,
  };

  const diagnostics = {
    stats,
    contactsWithoutPhone: [],
    unlinkedMessages: unlinkedMessages.slice(0, 2000).map(diagnosticMessage),
    possibleDuplicates: [],
    suspiciousPhones: messages
      .filter((m) => m.userPhoneInfo.isPlatformId || m.userHostPhoneInfo.isPlatformId)
      .map(diagnosticMessage)
      .slice(0, 2000),
    conversationsByChannel: messageChannels,
    missingExistingLeads: 0,
  };

  return { leads, stats, diagnostics, unlinkedConversations };
}

export async function uploadLeads(leads, onProgress, context = {}) {
  return uploadLeadsIncremental(leads, onProgress, context);
}

export async function uploadLeadsIncremental(leads, onProgress, context = {}) {
  const stats = context.stats || {};
  const importBatchId = stats.importBatchId || leads[0]?.importBatchId || `keybe_${Date.now()}`;
  const runRef = doc(db, COLLECTIONS.KEYBE_IMPORT_RUNS, importBatchId);
  const messagesOnly = context.importMode === 'messages_only' || stats.importMode === 'messages_only';
  const importLabel = messagesOnly ? 'conversaciones' : 'contactos';
  const shouldResume = context.resume !== false;
  const previousRun = await readImportRun(runRef);

  if (previousRun?.status === 'completed' && context.force !== true) {
    onProgress?.(100, 'Este archivo ya fue importado completamente. No se vuelve a gastar cuota en lo mismo.');
    return {
      alreadyCompleted: true,
      uploaded: Number(previousRun.updatedLeads || previousRun.uploaded || 0),
      skippedLeads: Number(previousRun.skippedLeads || 0),
      updatedLeads: Number(previousRun.updatedLeads || 0),
      messagesSaved: Number(previousRun.messagesSaved || 0),
      messagesOmitted: Number(previousRun.messagesOmitted || 0),
      updatedMessages: Number(previousRun.updatedMessages || 0),
      failedLeads: Number(previousRun.failedLeads || 0),
      processedLeads: Number(previousRun.processedLeads || leads.length),
    };
  }

  const startIndex = resolveResumeIndexFromRun(previousRun, shouldResume);
  const summary = buildResumeSummary(previousRun, startIndex);
  const maxLeadsPerRun = Number(context.maxLeadsPerRun || (messagesOnly ? 120 : 400));
  const maxWriteOpsPerRun = Number(context.maxWriteOpsPerRun || (messagesOnly ? 3500 : 4500));
  const maxMillisPerRun = Number(context.maxMillisPerRun || 18 * 60 * 1000);
  const deadline = Date.now() + maxMillisPerRun;
  let processedThisRun = 0;
  // Conteo PRECISO de escrituras reales hechas en esta corrida (lead + mensajes + doc de
  // sincronización). Se usa para el tope diario y por-tanda, para no subestimar la cuota.
  let runActualWrites = 0;

  // Tope diario acumulado entre todas las tandas del día (no por corrida).
  const dailyWriteCap = Number(context.dailyWriteCap || DEFAULT_DAILY_WRITE_CAP);
  const quotaRef = dailyQuotaRef();
  const writesUsedToday = await readDailyWrites(quotaRef);
  let dailyWritesPersisted = 0; // escrituras de ESTA corrida ya sumadas al contador diario

  // Si hoy ya no queda cupo de escrituras, no empezamos: evita reventar la cuota
  // aunque le des "Importar" varias veces el mismo día.
  if (writesUsedToday >= dailyWriteCap && startIndex < leads.length) {
    await saveImportRun(runRef, {
      ...summary,
      status: 'paused_quota',
      processedLeads: startIndex,
      lastProcessedIndex: startIndex - 1,
      pausedAt: serverTimestamp(),
      pauseReason: 'daily_quota_cap',
      nextIndex: startIndex,
      writesUsedToday,
      dailyWriteCap,
    });
    onProgress?.(
      Math.round((startIndex / leads.length) * 100),
      `Cuota diaria alcanzada (${writesUsedToday}/${dailyWriteCap} escrituras). Vuelve mañana con los mismos archivos y continúa desde aquí.`
    );
    return {
      ...summary,
      paused: true,
      pauseReason: 'daily_quota_cap',
      processedLeads: startIndex,
      nextIndex: startIndex,
      totalLeads: leads.length,
      writesUsedToday,
      dailyWriteCap,
    };
  }

  await saveImportBatch(importBatchId, {
    ...stats,
    diagnosticsSummary: buildDiagnosticsSummary(context.diagnostics),
    status: 'running',
    resumeEnabled: shouldResume,
  });

  await saveImportRun(runRef, {
    status: 'running',
    totalLeads: leads.length,
    processedLeads: startIndex,
    lastProcessedIndex: startIndex - 1,
    resumedFromIndex: startIndex,
    resumeEnabled: shouldResume,
    maxLeadsPerRun,
    maxWriteOpsPerRun,
    lastRunStartedAt: serverTimestamp(),
    startedAt: previousRun?.startedAt || serverTimestamp(),
    ...summary,
  });

  // Pre-cargar docs de sincronizacion en lotes de 30 para ahorrar lecturas de Firestore
  const { cache: syncCache, ok: syncCacheOk } = await prefetchSyncCache(leads, startIndex, importBatchId);

  for (let i = startIndex; i < leads.length; i++) {
    const lead = leads[i];
    const docId = lead.phone || `nophone_${i}_${importBatchId}`;
    const writesBeforeLead = runActualWrites;
    try {
      const leadSync = buildLeadSyncPayload(lead, importBatchId);
      const syncRef = doc(db, COLLECTIONS.KEYBE_LEAD_SYNC, docId);
      let previous;
      if (syncCacheOk && syncCache.has(docId)) {
        // Estaba en el prefetch → usar sin gastar lectura extra
        previous = syncCache.get(docId);
      } else if (syncCacheOk && i < startIndex + 300) {
        // Estaba en el rango prefetcheado pero no existe en Firestore → nuevo
        previous = null;
      } else {
        // Fuera del rango prefetcheado o prefetch falló → leer individualmente
        const syncSnap = await getDoc(syncRef);
        previous = syncSnap.exists() ? syncSnap.data() : null;
      }
      const sameLead = messagesOnly || previous?.leadHash === leadSync.leadHash;
      const sameConversation = previous?.conversationHash === leadSync.conversationHash;

      if (sameLead && sameConversation) {
        summary.skippedLeads++;
      } else {
        if (!sameLead && !messagesOnly) {
          const { _messages, ...leadData } = lead;
          await upsertLead(docId, leadData);
          summary.updatedLeads++;
          summary.uploaded++;
          runActualWrites++;
        }

        if (!sameConversation) {
          const res = await upsertLeadMessages(docId, lead._messages || []);
          summary.messagesSaved += res.saved;
          summary.messagesOmitted += res.omitted;
          summary.updatedMessages += res.saved;
          runActualWrites += res.saved;
        }

        await setDoc(syncRef, {
          ...leadSync,
          updatedAt: serverTimestamp(),
        }, { merge: true });
        runActualWrites++; // el doc de sincronización también es una escritura
      }
    } catch (err) {
      console.error('No se pudo sincronizar lead Keybe', { leadId: docId, err });
      summary.failedLeads++;
    }

    processedThisRun++;
    const wroteThisLead = runActualWrites > writesBeforeLead;

    // Checkpoint adaptativo: muy seguido cuando estamos escribiendo (para no perder avance
    // si se corta la cuota), y espaciado cuando solo estamos saltando lo ya subido
    // (saltar cuesta solo lecturas baratas; guardar el avance cada 10 sería un gasto inútil).
    const isCheckpoint = i === leads.length - 1
      || (wroteThisLead && (i + 1) % 10 === 0)
      || (i + 1) % 100 === 0;
    if (isCheckpoint) {
      await saveImportRun(runRef, {
        ...summary,
        processedLeads: i + 1,
        lastProcessedIndex: i,
      });
      // Sumar al contador diario solo lo nuevo desde el último checkpoint.
      // Así el tope diario sigue siendo exacto aunque se cierre la página a mitad.
      const deltaWrites = runActualWrites - dailyWritesPersisted;
      if (deltaWrites > 0) {
        await addDailyWrites(quotaRef, deltaWrites);
        dailyWritesPersisted = runActualWrites;
      }
      const pct = Math.round(((i + 1) / leads.length) * 100);
      onProgress?.(pct, `Sincronizando ${importLabel}... ${i + 1} de ${leads.length} (saltados: ${summary.skippedLeads})`);
    }

    // Throttle SOLO cuando hubo escritura real. Los saltos no gastan cuota de escritura,
    // así que pasamos sobre lo ya subido sin frenar.
    if (wroteThisLead) {
      await sleep(messagesOnly ? 250 : 100);
    }

    const writeOpsThisRun = runActualWrites;
    const dailyWriteTotal = writesUsedToday + writeOpsThisRun;
    // La pausa se decide por ESCRITURAS reales, tope diario o tiempo — nunca por contar
    // registros que se saltan (esos no gastan cuota de escritura).
    const shouldPause = i < leads.length - 1 && (
      writeOpsThisRun >= maxWriteOpsPerRun ||
      dailyWriteTotal >= dailyWriteCap ||
      Date.now() >= deadline
    );

    if (shouldPause) {
      // Asegurar que el contador diario quede al día antes de pausar.
      const deltaWrites = writeOpsThisRun - dailyWritesPersisted;
      if (deltaWrites > 0) {
        await addDailyWrites(quotaRef, deltaWrites);
        dailyWritesPersisted = writeOpsThisRun;
      }
      const pauseReason = dailyWriteTotal >= dailyWriteCap
        ? 'daily_quota_cap'
        : writeOpsThisRun >= maxWriteOpsPerRun
          ? 'run_write_limit'
          : 'time_limit';
      const writesUsedTodayNow = writesUsedToday + writeOpsThisRun;
      await saveImportRun(runRef, {
        ...summary,
        status: 'paused_quota',
        processedLeads: i + 1,
        lastProcessedIndex: i,
        pausedAt: serverTimestamp(),
        pauseReason,
        nextIndex: i + 1,
        writesUsedToday: writesUsedTodayNow,
        dailyWriteCap,
      });
      await saveImportBatch(importBatchId, {
        ...stats,
        status: 'paused_quota',
        pausedAt: new Date(),
        processedLeads: i + 1,
        nextIndex: i + 1,
        contactsUpserted: summary.updatedLeads,
        contactsSkipped: summary.skippedLeads,
        messagesSaved: summary.messagesSaved,
        messagesOmitted: summary.messagesOmitted,
        estimatedWriteOpsThisRun: writeOpsThisRun,
      });
      // Recalcular stats reales desde Firestore para que el dashboard refleje lo subido hasta ahora
      try { await recalcDashboardStatsFromFirestore(); } catch (_) {}
      const pauseMsg = pauseReason === 'daily_quota_cap'
        ? `Cuota diaria alcanzada (${writesUsedTodayNow}/${dailyWriteCap} escrituras): ${i + 1} de ${leads.length}. Vuelve mañana con los mismos archivos y continúa desde aquí.`
        : `Pausado para cuidar la cuota: ${i + 1} de ${leads.length}. Vuelve a cargar los mismos archivos para continuar desde aquí.`;
      onProgress?.(Math.round(((i + 1) / leads.length) * 100), pauseMsg);
      return {
        ...summary,
        paused: true,
        pauseReason,
        estimatedWriteOpsThisRun: writeOpsThisRun,
        processedLeads: i + 1,
        nextIndex: i + 1,
        totalLeads: leads.length,
        writesUsedToday: writesUsedTodayNow,
        dailyWriteCap,
      };
    }
  }

  const unlinkedConvs = context.unlinkedConversations || [];
  const unlinkedHash = hashObject(unlinkedConvs.map((c) => c.id));
  let unlinkedSummary;
  if (previousRun?.unlinkedConvsHash === unlinkedHash && previousRun?.unlinkedConvsSaved > 0) {
    unlinkedSummary = { saved: previousRun.unlinkedConvsSaved };
    onProgress?.(100, `Conversaciones sin contacto sin cambios, ya guardadas (${unlinkedSummary.saved}).`);
  } else {
    unlinkedSummary = await upsertUnlinkedConversations(unlinkedConvs, onProgress);
  }
  if (context.updateDashboardStats !== false) {
    try {
      await recalcDashboardStatsFromFirestore();
    } catch (_) {
      await saveDashboardStats(calcStats(leads));
    }
  }
  await saveImportBatch(importBatchId, {
    ...stats,
    status: 'completed',
    completedAt: new Date(),
    contactsUpserted: summary.updatedLeads,
    contactsSkipped: summary.skippedLeads,
    messagesSaved: summary.messagesSaved,
    messagesOmitted: summary.messagesOmitted,
    unlinkedConversationsSaved: unlinkedSummary.saved,
  });
  await saveImportRun(runRef, {
    ...summary,
    status: 'completed',
    processedLeads: leads.length,
    lastProcessedIndex: leads.length - 1,
    completedAt: serverTimestamp(),
    unlinkedConvsHash: unlinkedHash,
    unlinkedConvsSaved: unlinkedSummary.saved,
  });
  return {
    uploaded: summary.updatedLeads,
    skippedLeads: summary.skippedLeads,
    updatedLeads: summary.updatedLeads,
    messagesSaved: summary.messagesSaved,
    messagesOmitted: summary.messagesOmitted,
    updatedMessages: summary.updatedMessages,
    failedLeads: summary.failedLeads,
    unlinkedConversationsSaved: unlinkedSummary.saved,
  };
}

async function prefetchSyncCache(leads, startIndex, importBatchId) {
  const cache = new Map();
  const BATCH = 30;
  // Prefetch máximo de 300 leads a la vez para no hacer cientos de queries antes de empezar.
  // Para runs grandes, los leads restantes usarán el cache parcial y se saltarán si el hash coincide.
  const MAX_PREFETCH = 300;
  const slice = leads.slice(startIndex, startIndex + MAX_PREFETCH);
  if (!slice.length) return { cache, ok: true };

  const ids = slice.map((lead, i) => lead.phone || `nophone_${startIndex + i}_${importBatchId}`);
  let ok = true;

  for (let i = 0; i < ids.length; i += BATCH) {
    const batchIds = ids.slice(i, i + BATCH);
    try {
      const q = query(
        collection(db, COLLECTIONS.KEYBE_LEAD_SYNC),
        where(documentId(), 'in', batchIds)
      );
      const snap = await getDocs(q);
      snap.docs.forEach((d) => cache.set(d.id, d.data()));
    } catch (err) {
      console.warn('prefetchSyncCache batch failed, se usara getDoc por lead', err);
      ok = false;
      break;
    }
    if (i + BATCH < ids.length) await sleep(80);
  }

  return { cache, ok };
}

async function readImportRun(ref) {
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

// ── Contador diario de escrituras ───────────────────────────────────────────
// La cuota gratuita de Firestore se reinicia a medianoche hora del Pacífico (EE.UU.),
// así que la clave del día se calcula en esa zona horaria para que el contador
// se reinicie exactamente cuando Firebase reinicia la cuota.
function pacificDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dailyQuotaRef() {
  return doc(db, COLLECTIONS.KEYBE_IMPORT_RUNS, `__daily_quota__${pacificDateKey()}`);
}

async function readDailyWrites(ref) {
  try {
    const snap = await getDoc(ref);
    return snap.exists() ? Number(snap.data().writes || 0) : 0;
  } catch (err) {
    console.warn('No se pudo leer el contador diario de escrituras', err);
    return 0;
  }
}

async function addDailyWrites(ref, delta) {
  if (!delta || delta <= 0) return;
  try {
    await setDoc(ref, {
      writes: increment(delta),
      dateKey: pacificDateKey(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.warn('No se pudo actualizar el contador diario de escrituras', err);
  }
}

function buildResumeSummary(previousRun, startIndex) {
  const shouldCarry = previousRun && startIndex > 0 && previousRun.status !== 'completed';
  return {
    uploaded: shouldCarry ? Number(previousRun.uploaded || previousRun.updatedLeads || 0) : 0,
    skippedLeads: shouldCarry ? Number(previousRun.skippedLeads || 0) : 0,
    updatedLeads: shouldCarry ? Number(previousRun.updatedLeads || 0) : 0,
    messagesSaved: shouldCarry ? Number(previousRun.messagesSaved || 0) : 0,
    messagesOmitted: shouldCarry ? Number(previousRun.messagesOmitted || 0) : 0,
    updatedMessages: shouldCarry ? Number(previousRun.updatedMessages || 0) : 0,
    failedLeads: shouldCarry ? Number(previousRun.failedLeads || 0) : 0,
  };
}

async function saveImportRun(ref, data) {
  await setDoc(ref, { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

function resolveResumeIndexFromRun(data, shouldResume) {
  if (!shouldResume || !data) return 0;
  if (data.status === 'completed') return 0;
  return Math.max(0, Number(data.lastProcessedIndex ?? -1) + 1);
}

function buildLeadSyncPayload(lead, importBatchId) {
  const messages = lead._messages || [];
  const first = messages[0] || null;
  const last = messages[messages.length - 1] || null;
  const messageFingerprints = messages.map((msg) => ({
    id: msg.id,
    textHash: hashText(msg.text),
    createdAt: normalizeDateForHash(msg.createdAt),
    sender: msg.sender || msg.author || '',
    direction: msg.direction || '',
  }));

  return {
    leadHash: hashObject(cleanLeadForHash(lead)),
    conversationHash: hashObject({
      messageCount: messages.length,
      firstMessageAt: normalizeDateForHash(first?.createdAt),
      lastMessageAt: normalizeDateForHash(last?.createdAt),
      messages: messageFingerprints,
    }),
    messageCount: messages.length,
    firstMessageAt: first?.createdAt || null,
    lastMessageAt: last?.createdAt || null,
    lastImportBatchId: importBatchId,
  };
}

function cleanLeadForHash(lead) {
  const volatile = new Set([
    '_messages',
    'updatedAt',
    'createdAt',
    'importedAt',
    'importBatchId',
    'serverTimestamp',
    'reviewedAt',
    'reviewedBy',
    'reviewedByEmail',
    'revisionStatus',
    'internalNote',
    'assignedTo',
    'isInOfficialDatabase',
  ]);
  return Object.entries(lead || {}).reduce((acc, [key, value]) => {
    if (!volatile.has(key)) acc[key] = value;
    return acc;
  }, {});
}

function normalizeDateForHash(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  return String(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildStableImportBatchId(mode, contactRows = [], messageRows = []) {
  // Muestreamos el archivo en lugar de iterar todas las filas.
  // Primeras 60 + últimas 60 filas de cada archivo son más que suficientes para un ID único.
  // Resultado: O(1) en lugar de O(172k), y estable aunque Excel parsee fechas distinto.
  const SAMPLE = 60;

  const sampleRows = (rows, picker) => {
    if (!rows.length) return '';
    const head = rows.slice(0, SAMPLE);
    const tail = rows.length > SAMPLE ? rows.slice(-SAMPLE) : [];
    return [...head, ...tail]
      .map((r, i) => `${i}:${stableStringify(picker(r))}`)
      .join('|');
  };

  const meta    = `${mode}|c:${contactRows.length}|m:${messageRows.length}`;
  const cSample = sampleRows(contactRows, pickContactImportFields);
  const mSample = sampleRows(messageRows, pickMessageImportFields);

  const acc = hashText(`${meta}||${hashText(cSample)}||${hashText(mSample)}`);
  return `${mode === 'messages_only' ? 'keybe_msg' : 'keybe'}_v2_${acc}`;
  // Nota: el sufijo _v2_ diferencia de IDs generados con el algoritmo antiguo (todas las filas).
  // Runs pausados con el algoritmo viejo NO se reanudan automáticamente; hay que reiniciarlos.
}

function pickContactImportFields(row) {
  // Todos los valores como string para que el hash sea estable sin importar
  // cómo parsee Excel las fechas/números entre sesiones.
  return {
    uuid:     String(row.uuid     || '').trim(),
    phone:    String(row.phone    || '').trim(),
    email:    String(row.email    || '').trim().toLowerCase(),
    name:     String(row.name     || '').trim(),
    surname:  String(row.surname  || '').trim(),
  };
}

function pickMessageImportFields(row) {
  return {
    channel:  String(row.channel  || row.source  || row.typechannel || '').trim(),
    roomId:   String(row.roomid   || row.roomId   || '').trim(),
    userPhone: String(row.user_phone || row.userphone || '').trim(),
    userHost: String(row.userhost  || row.userHost || '').trim(),
    sender:   String(row.sender   || row.author   || row.agent || '').trim(),
    type:     String(row.type     || row.direction || '').trim(),
    // Solo los primeros 120 chars del texto para no hacer el hash lento con mensajes largos
    text:     String(row.text     || row.message  || row.body  || '').trim().slice(0, 120),
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
