// ─────────────────────────────────────────────────────────
// state.js — Estado global reactivo de la app
// ─────────────────────────────────────────────────────────

const _state = {
  // Auth
  currentUser:    null,   // objeto Firebase User
  userProfile:    null,   // documento de Firestore profiles/

  // Navegación
  currentView:    'dashboard',   // 'dashboard' | 'leads' | 'lead-detail' | 'import'

  // Leads
  allLeads:       [],     // todos los leads cargados en memoria
  filteredLeads:  [],     // leads después de aplicar filtros
  currentPage:    1,
  currentLead:    null,   // lead abierto en ficha

  // Filtros activos
  filters: {
    search:   '',
    status:   '',
    assigned: '',
    channel:  '',
    interest: '',
  },

  // Importación
  importContactsData:  null,   // array parseado de contacts.xlsx
  importMessagesData:  null,   // array parseado de messages.xlsx
  importProcessed:     null,   // array de leads ya unificados, antes de subir
};

// Listeners para reaccionar a cambios de estado
const _listeners = {};

/**
 * Obtiene un valor del estado global.
 * @param {string} key
 */
export function getState(key) {
  return _state[key];
}

/**
 * Actualiza uno o varios valores del estado y notifica listeners.
 * @param {Object} updates — objeto con los campos a actualizar
 */
export function setState(updates) {
  Object.assign(_state, updates);

  for (const key of Object.keys(updates)) {
    if (_listeners[key]) {
      for (const cb of _listeners[key]) {
        try { cb(_state[key]); } catch (e) { console.error('State listener error:', e); }
      }
    }
  }

  // Siempre notifica listeners de '*' (cambio general)
  if (_listeners['*']) {
    for (const cb of _listeners['*']) {
      try { cb(_state); } catch (e) { console.error('State listener error:', e); }
    }
  }
}

/**
 * Suscribirse a cambios de una clave de estado.
 * @param {string} key — clave o '*' para cualquier cambio
 * @param {Function} callback
 * @returns {Function} unsubscribe
 */
export function onStateChange(key, callback) {
  if (!_listeners[key]) _listeners[key] = [];
  _listeners[key].push(callback);
  return () => {
    _listeners[key] = _listeners[key].filter(cb => cb !== callback);
  };
}

/**
 * Actualiza solo los filtros activos.
 * @param {Object} filterUpdates
 */
export function setFilter(filterUpdates) {
  setState({ filters: { ..._state.filters, ...filterUpdates }, currentPage: 1 });
}

/**
 * Resetea todos los filtros.
 */
export function clearFilters() {
  setState({
    filters: { search: '', status: '', assigned: '', channel: '', interest: '' },
    currentPage: 1,
  });
}
