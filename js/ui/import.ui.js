// import.ui.js - Seccion de importacion de archivos Keybe.

import { getState } from '../utils/state.js';
import { parseContactsFile, parseMessagesFile, processImportData, processMessagesOnlyData, uploadLeads } from '../services/import.service.js';
import { showSuccess, showError, showInfo } from './toast.ui.js';

const getEl = (id) => document.getElementById(id);

let _contactsFile = null;
let _messagesFile = null;
let _processedLeads = null;
let _processedStats = null;
let _processedDiagnostics = null;
let _processedUnlinkedConversations = null;
let _importMode = 'full';

export function initImportUI() {
  bindFileZone('upload-contacts', 'contacts-file-name', 'contacts-status', 'upload-contacts-zone', (file) => {
    _contactsFile = file;
    checkReadyToImport();
  });

  bindFileZone('upload-messages', 'messages-file-name', 'messages-status', 'upload-messages-zone', (file) => {
    _messagesFile = file;
    checkReadyToImport();
  });

  getEl('btn-start-import')?.addEventListener('click', handleStartImport);
  getEl('btn-clear-import')?.addEventListener('click', resetImportForm);
  getEl('btn-download-diagnostics')?.addEventListener('click', downloadDiagnostics);
}

function bindFileZone(inputId, nameId, statusId, zoneId, onFile) {
  const input = getEl(inputId);
  const zone = getEl(zoneId);
  if (!input) return;

  input.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    handleFileSelected(file, nameId, statusId, zoneId, onFile);
  });

  zone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('has-file');
  });

  zone?.addEventListener('dragleave', () => {
    if (!input.files?.length) zone.classList.remove('has-file');
  });

  zone?.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    handleFileSelected(file, nameId, statusId, zoneId, onFile);
  });
}

function handleFileSelected(file, nameId, statusId, zoneId, onFile) {
  const nameEl = getEl(nameId);
  const statusEl = getEl(statusId);
  const zoneEl = getEl(zoneId);

  if (nameEl) nameEl.textContent = `OK ${file.name} (${formatFileSize(file.size)})`;
  if (zoneEl) zoneEl.classList.add('has-file');

  if (statusEl) {
    statusEl.hidden = false;
    statusEl.textContent = `Archivo seleccionado: ${file.name}`;
    statusEl.style.color = 'var(--c-green)';
  }

  onFile(file);
}

async function checkReadyToImport() {
  const btn = getEl('btn-start-import');

  if (_messagesFile) {
    try {
      showInfo('Analizando archivos...', 2000);
      const messages = await parseMessagesFile(_messagesFile);
      const result = _contactsFile
        ? processImportData(await parseContactsFile(_contactsFile), messages)
        : processMessagesOnlyData(messages);
      const { leads, stats, diagnostics, unlinkedConversations } = result;

      _processedLeads = leads;
      _processedStats = stats;
      _processedDiagnostics = diagnostics;
      _processedUnlinkedConversations = unlinkedConversations;
      _importMode = _contactsFile ? 'full' : 'messages_only';
      renderPreview(stats);

      if (btn) btn.disabled = !leads.length;
      if (!leads.length) showError('No se encontraron conversaciones asociables a contactos existentes.');
    } catch (err) {
      showError(err.message);
      if (btn) btn.disabled = true;
      _processedLeads = null;
      _processedStats = null;
    }
  } else {
    if (btn) btn.disabled = true;
    hidePreview();
  }
}

function renderPreview(stats) {
  const previewEl = getEl('import-preview');
  const previewStatsEl = getEl('import-preview-stats');
  if (!previewEl || !previewStatsEl) return;

  const rows = [
    { label: 'Modo', value: stats.importMode === 'messages_only' ? 'Solo mensajes' : 'Contactos + mensajes' },
    { label: 'Filas en contacts.xlsx', value: stats.totalContactRows },
    { label: 'Filas en messages.xlsx', value: stats.totalMessageRows },
    { label: stats.importMode === 'messages_only' ? 'Conversaciones a sincronizar' : 'Contactos unicos a crear/actualizar', value: stats.uniqueImportableContacts },
    { label: 'Contactos con telefono valido', value: stats.contactsWithValidPhone },
    { label: 'Contactos sin telefono real', value: stats.contactsWithoutPhone },
    { label: 'Contactos con email', value: stats.contactsWithEmail },
    { label: 'Duplicados por telefono', value: stats.duplicateGroups },
    { label: stats.importMode === 'messages_only' ? 'Telefonos con mensajes' : 'Contactos con mensajes', value: stats.contactsWithMessages },
    { label: stats.importMode === 'messages_only' ? 'Telefonos sin mensajes' : 'Contactos sin mensajes', value: stats.contactsWithoutMessages },
    { label: 'Mensajes con telefono valido', value: stats.messagesWithValidPhone },
    { label: 'Mensajes sin telefono real', value: stats.messagesWithoutRealPhone },
    { label: 'Mensajes asociables a contacto', value: stats.messagesAssociableToContact },
    { label: 'Mensajes no asociados', value: stats.messagesWithoutContact },
    { label: 'Conversaciones detectadas', value: stats.conversationsDetected },
    { label: 'Conversaciones sin contacto', value: stats.conversationsWithoutContact },
    { label: 'Telefonos sin contacto existente', value: stats.missingExistingLeads || 0 },
    { label: 'Posibles errores de fecha', value: stats.possibleDateErrors },
    { label: 'Telefonos recuperados de notacion cientifica', value: stats.phonesRecoveredFromScientificNotation },
  ];

  previewStatsEl.innerHTML = rows.map((s) => `
    <div class="preview-stat">
      <span>${escHtml(s.label)}</span>
      <strong>${s.value}</strong>
    </div>
  `).join('');

  const oldNotes = previewEl.querySelector('.import-preview-notes');
  oldNotes?.remove();

  const notes = [
    stats.contactRowsWithoutPhone > 0 ? `Se detectaron ${stats.contactRowsWithoutPhone} contactos sin telefono real. Quedan en diagnostico, no se inventa asociacion.` : '',
    stats.duplicateGroups > 0 ? `Se detectaron ${stats.duplicateGroups} grupos de duplicados por telefono. Se conserva todo en allOriginalFields.` : '',
    stats.importMode === 'messages_only'
      ? `Se prepararon ${stats.associatedMessages} mensajes para sincronizar en conversaciones existentes.`
      : `Se asociaron ${stats.associatedMessages} mensajes a contactos importados.`,
    stats.importMode === 'messages_only' ? 'Modo solo mensajes: no se crean contactos nuevos ni se reimporta contacts.xlsx.' : '',
    stats.missingExistingLeads > 0 ? `${stats.missingExistingLeads} telefonos del archivo de mensajes no existen como contacto en Firestore y quedan en diagnostico.` : '',
    stats.messagesWithoutContact > 0 ? `${stats.messagesWithoutContact} mensajes quedan como conversaciones sin contacto asociado.` : '',
    stats.phonesRecoveredFromScientificNotation > 0 ? `${stats.phonesRecoveredFromScientificNotation} telefonos fueron recuperados desde notacion cientifica.` : '',
  ].filter(Boolean);

  previewEl.insertAdjacentHTML('beforeend', `
    <div class="import-preview-notes">
      ${notes.map((msg) => `<p>${escHtml(msg)}</p>`).join('')}
    </div>
  `);

  previewEl.hidden = false;
}

function hidePreview() {
  const el = getEl('import-preview');
  if (el) el.hidden = true;
}

async function handleStartImport() {
  if (!_processedLeads || !_processedLeads.length) {
    showError('No hay datos para importar.');
    return;
  }

  const profile = getState('userProfile');
  if (profile?.role !== 'admin') {
    showError('Solo los administradores pueden importar datos.');
    return;
  }

  const btnStart = getEl('btn-start-import');
  const progressEl = getEl('import-progress');
  const resultEl = getEl('import-result');
  const fillEl = getEl('import-progress-fill');
  const pctEl = getEl('import-progress-pct');
  const msgEl = getEl('import-progress-msg');

  if (btnStart) btnStart.disabled = true;
  if (progressEl) progressEl.hidden = false;
  if (resultEl) resultEl.hidden = true;

  try {
    const summary = await uploadLeads(_processedLeads, (pct, msg) => {
      if (fillEl) fillEl.style.width = `${pct}%`;
      if (pctEl) pctEl.textContent = `${pct}%`;
      if (msgEl) msgEl.textContent = msg;
    }, {
      stats: _processedStats,
      diagnostics: _processedDiagnostics,
      unlinkedConversations: _processedUnlinkedConversations,
      updateDashboardStats: _importMode !== 'messages_only',
      importMode: _importMode,
      resume: true,
      // El limite real es el tope diario (16.000). El tope por corrida se deja igual al
      // diario para que UNA sola corrida pueda usar todo el cupo del dia (1 clic/dia).
      // El limite de tiempo (18 min) protege contra una pestania colgada.
      maxWriteOpsPerRun: 16000,
      maxMillisPerRun: 18 * 60 * 1000,
      dailyWriteCap: 16000,
    });

    const finalPct = summary.paused && summary.totalLeads
      ? Math.round(((summary.processedLeads || 0) / summary.totalLeads) * 100)
      : 100;
    if (fillEl) fillEl.style.width = `${finalPct}%`;
    if (pctEl) pctEl.textContent = `${finalPct}%`;
    if (msgEl) {
      msgEl.textContent = summary.paused
        ? 'Importacion pausada para cuidar la cuota.'
        : summary.alreadyCompleted
          ? 'Este archivo ya estaba importado completamente.'
          : 'Importacion completada.';
    }

    if (resultEl) {
      resultEl.hidden = false;
      resultEl.className = summary.paused ? 'import-result warning' : 'import-result';
      resultEl.innerHTML = renderImportSummary(summary);
    }

    if (summary.paused) {
      showInfo(`Importacion pausada en ${summary.processedLeads} de ${summary.totalLeads}. Puedes continuar despues con los mismos archivos.`, 8000);
    } else if (summary.alreadyCompleted) {
      showInfo('Ese archivo ya estaba importado. No se repitio la subida.', 6000);
    } else {
      showSuccess(_importMode === 'messages_only'
        ? `Conversaciones actualizadas para ${_processedLeads.length} contactos existentes.`
        : `${_processedLeads.length} contactos unicos importados correctamente.`);
    }
    document.dispatchEvent(new CustomEvent('leads-imported'));
  } catch (err) {
    console.error(err);
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.className = 'import-result error';
      resultEl.innerHTML = `<strong>Error en la importacion</strong><br/>${escHtml(err.message)}`;
    }
    showError('Error durante la importacion: ' + err.message);
  } finally {
    if (btnStart) btnStart.disabled = false;
  }
}


function renderImportSummary(summary) {
  if (summary.alreadyCompleted) {
    return `
      <strong>Archivo ya importado</strong><br/>
      No se repitio la subida ni se gasto cuota reescribiendo la misma informacion.<br/>
      Contactos actualizados previamente: <strong>${summary.updatedLeads ?? summary.uploaded ?? 0}</strong>. Saltados: <strong>${summary.skippedLeads ?? 0}</strong>.
    `;
  }

  if (summary.paused) {
    const dailyCapReached = summary.pauseReason === 'daily_quota_cap';
    const quotaLine = summary.dailyWriteCap
      ? `Escrituras usadas hoy: <strong>${summary.writesUsedToday ?? 0}</strong> de <strong>${summary.dailyWriteCap}</strong>.<br/>`
      : '';
    return `
      <strong>${dailyCapReached ? 'Cuota diaria alcanzada' : 'Importacion pausada para cuidar la cuota'}</strong><br/>
      ${quotaLine}
      Avance guardado: <strong>${summary.processedLeads ?? 0}</strong> de <strong>${summary.totalLeads ?? _processedLeads.length}</strong>.<br/>
      Contactos actualizados: <strong>${summary.updatedLeads ?? summary.uploaded ?? 0}</strong>. Saltados sin cambios: <strong>${summary.skippedLeads ?? 0}</strong>.<br/>
      Mensajes guardados/actualizados: <strong>${summary.messagesSaved ?? 0}</strong>. Omitidos: <strong>${summary.messagesOmitted ?? 0}</strong>. Fallidos: <strong>${summary.failedLeads ?? 0}</strong>.<br/>
      Escrituras estimadas en esta tanda: <strong>${summary.estimatedWriteOpsThisRun ?? 0}</strong>.<br/>
      Para continuar, vuelve a cargar exactamente los mismos archivos y presiona importar. La app seguira desde el ultimo contacto procesado.
    `;
  }

  return _importMode === 'messages_only'
    ? `
      <strong>Importacion de mensajes exitosa</strong><br/>
      Conversaciones revisadas: <strong>${_processedLeads.length}</strong>. Saltadas sin cambios: <strong>${summary.skippedLeads ?? 0}</strong>.<br/>
      Mensajes guardados/actualizados: <strong>${summary.messagesSaved ?? 0}</strong>. Omitidos: <strong>${summary.messagesOmitted ?? 0}</strong>. Fallidos: <strong>${summary.failedLeads ?? 0}</strong>.<br/>
      Conversaciones sin contacto guardadas/actualizadas: <strong>${summary.unlinkedConversationsSaved ?? 0}</strong>.
    `
    : `
      <strong>Importacion exitosa</strong><br/>
      Contactos actualizados: <strong>${summary.updatedLeads ?? summary.uploaded ?? 0}</strong>. Saltados sin cambios: <strong>${summary.skippedLeads ?? 0}</strong>.<br/>
      Mensajes guardados/actualizados: <strong>${summary.messagesSaved ?? 0}</strong>. Omitidos: <strong>${summary.messagesOmitted ?? 0}</strong>. Fallidos: <strong>${summary.failedLeads ?? 0}</strong>.<br/>
      Conversaciones sin contacto guardadas/actualizadas: <strong>${summary.unlinkedConversationsSaved ?? 0}</strong>.<br/>
      Ya puedes ir a la seccion <strong>Contactos</strong> para comenzar la revision.
    `;
}

function resetImportForm() {
  _contactsFile = null;
  _messagesFile = null;
  _processedLeads = null;
  _processedStats = null;
  _processedDiagnostics = null;
  _processedUnlinkedConversations = null;
  _importMode = 'full';

  const ids = [
    'upload-contacts', 'upload-messages',
    'contacts-status', 'messages-status',
    'import-preview', 'import-progress', 'import-result',
  ];

  for (const id of ids) {
    const el = getEl(id);
    if (el) {
      if (el.tagName === 'INPUT') el.value = '';
      else el.hidden = true;
    }
  }

  const defaults = [
    'Haz clic para seleccionar o arrastra el archivo aqui',
    'Haz clic para seleccionar o arrastra el archivo aqui',
  ];

  ['contacts-file-name', 'messages-file-name'].forEach((id, i) => {
    const el = getEl(id);
    if (el) el.textContent = defaults[i];
  });

  ['upload-contacts-zone', 'upload-messages-zone'].forEach((id) => {
    getEl(id)?.classList.remove('has-file');
  });

  const btn = getEl('btn-start-import');
  if (btn) btn.disabled = true;
}

function downloadDiagnostics() {
  if (!_processedDiagnostics) {
    showError('Primero carga y analiza los archivos.');
    return;
  }
  const blob = new Blob([JSON.stringify(_processedDiagnostics, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `diagnostico-keybe-${_processedStats?.importBatchId || Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
