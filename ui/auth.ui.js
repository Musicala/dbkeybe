import {
  loginWithGoogle,
  logout,
  fetchUserProfile,
  onAuthChange,
} from '../services/auth.service.js';
import { setState } from '../utils/state.js';
import { showError, showSuccess } from './toast.ui.js';

const getEl = (id) => document.getElementById(id);

export function initAuth(onAuthenticated, onUnauthenticated) {
  bindLoginForm();
  bindLogoutButton();

  onAuthChange(async (firebaseUser) => {
    if (firebaseUser) {
      try {
        const profile = await fetchUserProfile(firebaseUser.uid, firebaseUser);
        setState({ currentUser: firebaseUser, userProfile: profile });
        updateSidebarUser(profile);
        updateAdminVisibility(profile);
        onAuthenticated(firebaseUser, profile);
      } catch (err) {
        showError(err.message);
        onUnauthenticated();
      }
    } else {
      setState({ currentUser: null, userProfile: null });
      onUnauthenticated();
    }
  });
}

function bindLoginForm() {
  const form = getEl('login-form');

  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    setLoginLoading(true);
    hideLoginError();

    try {
      await loginWithGoogle();
    } catch (err) {
      showLoginError(err.message);
      setLoginLoading(false);
    }
  });
}

function setLoginLoading(loading) {
  const btn = getEl('btn-login');
  const label = btn?.querySelector('.btn-label');
  const spinner = btn?.querySelector('.btn-spinner');

  if (!btn) return;

  btn.disabled = loading;
  if (label) label.hidden = loading;
  if (spinner) spinner.hidden = !loading;
}

function showLoginError(msg) {
  const errEl = getEl('login-error');
  if (!errEl) return;

  errEl.textContent = msg;
  errEl.hidden = false;
}

function hideLoginError() {
  const errEl = getEl('login-error');
  if (errEl) errEl.hidden = true;
}

function bindLogoutButton() {
  getEl('btn-logout')?.addEventListener('click', async () => {
    try {
      await logout();
      showSuccess('Sesion cerrada correctamente.');
    } catch (err) {
      showError('No se pudo cerrar la sesion.');
    }
  });
}

export function updateSidebarUser(profile) {
  const nameEl = getEl('sidebar-user-name');
  const roleEl = getEl('sidebar-user-role');
  const avatarEl = getEl('sidebar-user-avatar');
  const displayName = profile?.name || profile?.displayName || profile?.email || '-';

  if (nameEl) nameEl.textContent = displayName;
  if (roleEl) roleEl.textContent = profile?.role === 'admin' ? 'Administrador' : 'Asistente';
  if (avatarEl) avatarEl.textContent = displayName[0]?.toUpperCase() || '?';
}

export function updateAdminVisibility(profile) {
  const isAdmin = profile?.role === 'admin';
  const navImport = getEl('nav-import');
  if (navImport) navImport.style.display = isAdmin ? '' : 'none';
}
