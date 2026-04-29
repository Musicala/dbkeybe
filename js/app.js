// ─────────────────────────────────────────────────────────
// app.js — Entry point. Inicializa la app y maneja el router.
// ─────────────────────────────────────────────────────────

import { initAuth }           from './ui/auth.ui.js';
import { initLeadsUI, applyFiltersAndRender } from './ui/leads.ui.js';
import { initLeadDetailUI, renderLeadDetail } from './ui/lead-detail.ui.js';
import { initImportUI }       from './ui/import.ui.js';
import { renderDashboard }    from './ui/dashboard.ui.js';
import { getAllLeads }         from './services/firestore.service.js';
import { setState, getState } from './utils/state.js';

// ── Vistas disponibles ────────────────────────────────────
const VIEWS = {
  loading:     'view-loading',
  login:       'view-login',
  app:         'view-app',
};

const SECTIONS = {
  dashboard:    'section-dashboard',
  leads:        'section-leads',
  'lead-detail':'section-lead-detail',
  import:       'section-import',
};

// ── Mostrar/ocultar vistas principales ────────────────────
function showView(viewId) {
  Object.values(VIEWS).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', el.id === viewId);
  });
}

// ── Navegación entre secciones ─────────────────────────────
function navigateTo(sectionKey) {
  const profile = getState('userProfile');

  // Restringir importación a admin
  if (sectionKey === 'import' && profile?.role !== 'admin') {
    return;
  }

  // Ocultar todas las secciones
  Object.values(SECTIONS).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });

  // Mostrar la sección solicitada
  const targetId = SECTIONS[sectionKey];
  if (targetId) {
    const el = document.getElementById(targetId);
    if (el) el.classList.add('active');
  }

  // Actualizar nav activo en el sidebar
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === sectionKey);
    item.setAttribute('aria-current', item.dataset.view === sectionKey ? 'page' : 'false');
  });

  // Renderizar sección
  if (sectionKey === 'dashboard')    renderDashboard();
  if (sectionKey === 'leads')        applyFiltersAndRender();
  if (sectionKey === 'lead-detail')  renderLeadDetail();

  setState({ currentView: sectionKey });
}

// ── Cargar todos los leads desde Firestore ────────────────
async function loadLeads() {
  try {
    const leads = await getAllLeads();
    setState({ allLeads: leads, filteredLeads: leads });
  } catch (err) {
    console.error('Error cargando leads:', err);
  }
}

// ── Inicialización ────────────────────────────────────────
function init() {

  // Inicializar módulos UI que no dependen de auth
  initLeadsUI();
  initLeadDetailUI();
  initImportUI();

  // Sidebar nav — delegación de eventos
  document.querySelectorAll('.nav-item[data-view]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(item.dataset.view);
      closeSidebarMobile();
    });
  });

  // Botón actualizar dashboard
  document.getElementById('btn-refresh-dashboard')?.addEventListener('click', async () => {
    await loadLeads();
    renderDashboard();
  });

  // Evento de navegación interna (disparado desde leads.ui y lead-detail.ui)
  document.addEventListener('navigate', (e) => {
    navigateTo(e.detail.view);
  });

  // Evento post-importación: recargar leads
  document.addEventListener('leads-imported', async () => {
    await loadLeads();
    navigateTo('dashboard');
  });

  // Menú hamburguesa móvil
  const btnToggle   = document.getElementById('btn-menu-toggle');
  const sidebar     = document.getElementById('sidebar');
  const overlay     = document.getElementById('sidebar-overlay');

  btnToggle?.addEventListener('click', () => {
    sidebar?.classList.toggle('open');
    overlay?.classList.toggle('open');
  });

  overlay?.addEventListener('click', closeSidebarMobile);

  // Inicializar autenticación
  initAuth(
    // onAuthenticated
    async (_user, _profile) => {
      showView(VIEWS.app);
      await loadLeads();
      navigateTo('dashboard');
    },
    // onUnauthenticated
    () => {
      showView(VIEWS.login);
    }
  );

  // Ocultar pantalla de carga tras 300ms si Firebase ya respondió
  setTimeout(() => {
    const loadingEl = document.getElementById(VIEWS.loading);
    if (loadingEl?.classList.contains('active')) {
      // Aún cargando: Firebase tardará, lo manejará onAuthChange
    }
  }, 300);
}

function closeSidebarMobile() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
}

// ── Arrancar ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
