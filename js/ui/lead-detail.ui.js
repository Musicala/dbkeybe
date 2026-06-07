// ─────────────────────────────────────────────────────────
// lead-detail.ui.js — Ficha individual de contacto
// ─────────────────────────────────────────────────────────

import { getState, setState }    from '../utils/state.js';
import { updateLeadReview }      from '../services/firestore.service.js';
import { getLeadMessagesPage }   from '../services/messages.service.js';
import { formatDate, formatStatus, formatChannel } from '../utils/formatters.js';
import { displayPhone }          from '../utils/phone.utils.js';
import { showSuccess, showError } from './toast.ui.js';
import { serverTimestamp }        from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const getEl = (id) => document.getElementById(id);
let _conversationMessages = [];
let _conversationVisible = 80;
let _conversationQuery = '';
let _conversationCursor = null;
let _conversationHasMore = false;
let _conversationLeadId = null;

// ── Inicialización ────────────────────────────────────────

export function initLeadDetailUI() {
  getEl('btn-back-to-leads')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'leads' } }));
  });

  getEl('btn-save-lead')?.addEventListener('click', saveLead);
  getEl('detail-conversation-search')?.addEventListener('input', (e) => {
    _conversationQuery = e.target.value.trim().toLowerCase();
    _conversationVisible = 80;
    renderConversationList();
  });
  getEl('btn-load-more-messages')?.addEventListener('click', () => {
    loadMoreMessages();
  });
}

// ── Renderizar ficha ──────────────────────────────────────

export function renderLeadDetail() {
  const lead = getState('currentLead');
  if (!lead) return;

  // Encabezado
  setEl('detail-title',    lead.fullName || '(Sin nombre)');
  setEl('detail-subtitle', `Telefono: ${displayPhone(lead.phone)} - Canal: ${formatChannel(lead.channel)}`);

  // Datos básicos
  setEl('detail-fullname',      lead.fullName || '—');
  setEl('detail-phone',         lead.phoneE164 ? `${displayPhone(lead.phone)} (${lead.phoneE164})` : displayPhone(lead.phone));
  setEl('detail-email',         lead.email || '—');
  setEl('detail-channel',       formatChannel(lead.channel));
  setEl('detail-uuid',          lead.keybeContactUuid || '—');
  setEl('detail-keybe-created', formatDate(lead.keybeCreatedAt || lead.createdAt));

  // Actividad
  setEl('detail-msg-count',   lead.messageCount ?? 0);
  setEl('detail-last-msg-at', formatDate(lead.lastMessageAt));
  setEl('detail-interest',    lead.possibleInterest || 'Sin clasificar');
  setEl('detail-last-msg',    lead.lastMessage || '(Sin mensajes registrados)');
  setEl('detail-duplicate-info', buildDuplicateText(lead));
  renderQualityFlags(lead);
  renderConversation(lead);

  // Campos de revisión
  setSelectValue('detail-status',   lead.revisionStatus   || 'pendiente_revision');
  setSelectValue('detail-assigned', lead.assignedTo       || 'Sin asignar');

  const inBaseVal = lead.isInOfficialDatabase === true
    ? 'true'
    : lead.isInOfficialDatabase === false
    ? 'false'
    : '';
  setSelectValue('detail-in-base', inBaseVal);

  const noteEl = getEl('detail-note');
  if (noteEl) noteEl.value = lead.internalNote || '';

  // Meta de revisión
  const metaEl = getEl('detail-meta');
  if (lead.reviewedBy && metaEl) {
    metaEl.hidden = false;
    setEl('detail-reviewed-by', lead.reviewedBy);
    setEl('detail-reviewed-at', formatDate(lead.reviewedAt, true));
  } else if (metaEl) {
    metaEl.hidden = true;
  }
}

async function renderConversation(lead) {
  const listEl = getEl('detail-conversation-list');
  if (!listEl) return;

  listEl.innerHTML = '<p class="empty-state">Cargando conversacion...</p>';

  try {
    _conversationMessages = [];
    _conversationCursor = null;
    _conversationHasMore = false;
    _conversationLeadId = lead.id || lead.phone;
    const page = await getLeadMessagesPage(_conversationLeadId, { pageSize: 80 });
    const currentLead = getState('currentLead');
    if (!currentLead || currentLead.id !== lead.id) return;

    if (!page.messages.length) {
      listEl.innerHTML = `
        <p class="empty-state">
          No hay conversacion completa guardada para este contacto. Reimporta el archivo de mensajes para asociarla.
        </p>
      `;
      updateConversationControls();
      return;
    }

    _conversationMessages = [...page.messages].sort((a, b) => readDateMs(a.createdAt) - readDateMs(b.createdAt));
    _conversationCursor = page.cursor;
    _conversationHasMore = page.hasMore;
    _conversationVisible = 80;
    _conversationQuery = '';
    const searchEl = getEl('detail-conversation-search');
    if (searchEl) searchEl.value = '';
    renderConversationList();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p class="empty-state">No se pudo cargar la conversacion completa.</p>';
  }
}

async function loadMoreMessages() {
  if (!_conversationLeadId || !_conversationHasMore) return;
  const btn = getEl('btn-load-more-messages');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Cargando...';
  }

  try {
    const page = await getLeadMessagesPage(_conversationLeadId, {
      pageSize: 80,
      cursor: _conversationCursor,
    });
    _conversationMessages = [..._conversationMessages, ...page.messages]
      .sort((a, b) => readDateMs(a.createdAt) - readDateMs(b.createdAt));
    _conversationCursor = page.cursor;
    _conversationHasMore = page.hasMore;
    renderConversationList();
  } catch (err) {
    console.error(err);
    showError('No se pudieron cargar mas mensajes.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Cargar mas mensajes';
    }
  }
}

function renderConversationList() {
  const listEl = getEl('detail-conversation-list');
  if (!listEl) return;

  const filtered = _conversationQuery
    ? _conversationMessages.filter((msg) => String(msg.text || '').toLowerCase().includes(_conversationQuery))
    : _conversationMessages;
  const visible = filtered.slice(0, _conversationVisible);

  if (!visible.length) {
    listEl.innerHTML = '<p class="empty-state">No hay mensajes que coincidan con la busqueda.</p>';
  } else {
    listEl.innerHTML = visible.map((msg) => `
      <article class="conversation-item">
        <div class="conversation-meta">
          <span>${escHtml(formatDate(msg.createdAt, true))}</span>
          <span>${escHtml(formatChannel(msg.channel))}</span>
          <span>${escHtml(formatSpeaker(msg.direction || msg.type || msg.sender))}</span>
          ${msg.author || msg.sender ? `<span>${escHtml(msg.author || msg.sender)}</span>` : ''}
        </div>
        <p class="conversation-text">${escHtml(msg.text || '(Mensaje sin texto)')}</p>
      </article>
    `).join('');
  }

  const summary = getEl('detail-conversation-summary');
  if (summary) {
    const searchNote = _conversationQuery ? ' (busqueda solo en mensajes cargados)' : '';
    summary.textContent = `${Math.min(visible.length, filtered.length)} de ${filtered.length} mensajes cargados${_conversationHasMore ? '+' : ''}${searchNote}`;
  }
  updateConversationControls();
}

function updateConversationControls() {
  const moreBtn = getEl('btn-load-more-messages');
  if (moreBtn) moreBtn.hidden = !_conversationHasMore;
}

function buildDuplicateText(lead) {
  const isDuplicate = lead.isDuplicate === true || lead.revisionStatus === 'duplicado';
  if (!isDuplicate) return 'No se detectaron filas duplicadas para este telefono.';

  const totalRows = lead.duplicateRowsSummary?.totalRows || lead.duplicateCount || 2;
  const mergedRows = lead.duplicateRowsSummary?.mergedRows ?? Math.max(totalRows - 1, 0);
  const rows = lead.duplicateRowsSummary?.rowIndexes?.length
    ? ` Filas del Excel: ${lead.duplicateRowsSummary.rowIndexes.join(', ')}.`
    : '';

  return `Este contacto consolida ${totalRows} filas con el mismo telefono (${mergedRows} fusionadas).${rows}`;
}

function renderQualityFlags(lead) {
  const el = getEl('detail-quality-flags');
  if (!el) return;
  const q = lead.dataQuality || {};
  const flags = [
    q.hasValidPhone ? 'Telefono valido' : 'Sin telefono real',
    q.hasMessages ? 'Conversacion asociada automaticamente' : 'Sin conversacion asociada',
    q.possibleDuplicate || lead.isDuplicate ? 'Posible duplicado' : '',
    q.phoneWasRecoveredFromScientificNotation ? 'Telefono recuperado de notacion cientifica' : '',
  ].filter(Boolean);
  el.innerHTML = flags.map((flag) => `<span class="quality-pill">${escHtml(flag)}</span>`).join('');
}

function formatSpeaker(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('advisor') || raw.includes('agent') || raw.includes('asesor') || raw.includes('out')) return 'advisor';
  if (raw.includes('bot')) return 'bot';
  if (raw.includes('system') || raw.includes('sistema')) return 'system';
  if (raw.includes('user') || raw.includes('cliente') || raw.includes('in')) return 'user';
  return raw || 'desconocido';
}

function readDateMs(value) {
  if (!value) return 0;
  if (value.toDate) return value.toDate().getTime();
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// ── Guardar cambios ───────────────────────────────────────

async function saveLead() {
  const lead    = getState('currentLead');
  const profile = getState('userProfile');

  if (!lead || !profile) return;

  const btn = getEl('btn-save-lead');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }

  try {
    const status   = getEl('detail-status')?.value;
    const assigned = getEl('detail-assigned')?.value;
    const inBaseRaw = getEl('detail-in-base')?.value;
    const note     = getEl('detail-note')?.value.trim();

    const isInBase = inBaseRaw === 'true' ? true : inBaseRaw === 'false' ? false : null;

    const reviewData = {
      revisionStatus:      status,
      assignedTo:          assigned,
      isInOfficialDatabase: isInBase,
      internalNote:        note,
      reviewedBy:          profile.displayName || profile.email,
      reviewedByEmail:     profile.email,
      reviewedAt:          new Date(),
      updatedAt:           new Date(),
    };

    await updateLeadReview(lead.id, reviewData);

    // Actualizar en el estado local también
    const updatedLead = { ...lead, ...reviewData };
    setState({ currentLead: updatedLead });

    const pageLeads = getState('currentPageLeads') || [];
    const idx = pageLeads.findIndex((l) => l.id === lead.id);
    if (idx !== -1) {
      pageLeads[idx] = updatedLead;
      setState({ currentPageLeads: [...pageLeads], filteredLeads: [...pageLeads] });
    }

    showSuccess('Cambios guardados correctamente.');

    // Mostrar meta de revisión actualizada
    const metaEl = getEl('detail-meta');
    if (metaEl) {
      metaEl.hidden = false;
      setEl('detail-reviewed-by', reviewData.reviewedBy);
      setEl('detail-reviewed-at', formatDate(reviewData.reviewedAt, true));
    }

  } catch (err) {
    console.error(err);
    showError('No se pudieron guardar los cambios: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled    = false;
      btn.innerHTML   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13"/><polyline points="7 3 7 8 15 8"/></svg> Guardar cambios`;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────

function setEl(id, value) {
  const el = getEl(id);
  if (el) el.textContent = value ?? '—';
}

function setSelectValue(id, value) {
  const el = getEl(id);
  if (!el) return;
  el.value = value;
  // Fallback: si el value no existe en las opciones, seleccionar la primera
  if (el.value !== value) el.selectedIndex = 0;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
