// app.js - Entry point. Inicializa la app y maneja el router.

import { initAuth } from './ui/auth.ui.js';
import { initLeadsUI, applyFiltersAndRender } from './ui/leads.ui.js';
import { initLeadDetailUI, renderLeadDetail } from './ui/lead-detail.ui.js';
import { initImportUI } from './ui/import.ui.js';
import { renderDashboard } from './ui/dashboard.ui.js';
import { setState, getState } from './utils/state.js';

const VIEWS = {
  loading: 'view-loading',
  login: 'view-login',
  app: 'view-app',
};

const SECTIONS = {
  dashboard: 'section-dashboard',
  leads: 'section-leads',
  'lead-detail': 'section-lead-detail',
  import: 'section-import',
};

function showView(viewId) {
  Object.values(VIEWS).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', el.id === viewId);
  });
}

function navigateTo(sectionKey) {
  const profile = getState('userProfile');
  if (sectionKey === 'import' && profile?.role !== 'admin') return;

  Object.values(SECTIONS).forEach((id) => {
    document.getElementById(id)?.classList.remove('active');
  });

  const targetId = SECTIONS[sectionKey];
  if (targetId) document.getElementById(targetId)?.classList.add('active');

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === sectionKey);
    item.setAttribute('aria-current', item.dataset.view === sectionKey ? 'page' : 'false');
  });

  if (sectionKey === 'dashboard') renderDashboard();
  if (sectionKey === 'leads') applyFiltersAndRender();
  if (sectionKey === 'lead-detail') renderLeadDetail();

  setState({ currentView: sectionKey });
}

function init() {
  initLeadsUI();
  initLeadDetailUI();
  initImportUI();

  document.querySelectorAll('.nav-item[data-view]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(item.dataset.view);
      closeSidebarMobile();
    });
  });

  document.getElementById('btn-refresh-dashboard')?.addEventListener('click', () => renderDashboard({ forceRecalc: true }));

  document.addEventListener('navigate', (e) => {
    navigateTo(e.detail.view);
  });

  document.addEventListener('leads-imported', () => {
    navigateTo('dashboard');
  });

  const btnToggle = document.getElementById('btn-menu-toggle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');

  btnToggle?.addEventListener('click', () => {
    sidebar?.classList.toggle('open');
    overlay?.classList.toggle('open');
  });

  overlay?.addEventListener('click', closeSidebarMobile);

  initAuth(
    async () => {
      showView(VIEWS.app);
      navigateTo('dashboard');
    },
    () => {
      showView(VIEWS.login);
    }
  );
}

function closeSidebarMobile() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
}

document.addEventListener('DOMContentLoaded', init);
