// ─────────────────────────────────────────────────────────
// auth.service.js — Servicio de autenticación Musicala Keybe
// ─────────────────────────────────────────────────────────
// Responsabilidades:
// - Iniciar sesión con email/contraseña usando Firebase Auth.
// - Cerrar sesión.
// - Escuchar cambios de sesión.
// - Leer el perfil del usuario desde Firestore.
// - Validar si el usuario está autorizado y activo.
// - Guardar currentUser y userProfile en el estado global.
//
// Colección esperada:
// profiles/{uid}
// {
//   email: "correo@musicala.com",
//   name: "Nombre",
//   role: "admin" | "assistant",
//   active: true,
//   createdAt,
//   updatedAt
// }
//
// Nota:
// También intenta buscar perfil por email si no existe profiles/{uid},
// por si en algún momento crearon documentos manualmente con otro ID.
// Porque claro, Firestore también ama el caos administrativo.
// ─────────────────────────────────────────────────────────

import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

import {
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  where,
  limit,
  getDocs,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { auth, db } from '../config/firebase.config.js';
import { COLLECTIONS, ROLES } from '../utils/constants.js';
import { setState } from '../utils/state.js';

// ─────────────────────────────────────────────────────────
// Correos iniciales autorizados
// ─────────────────────────────────────────────────────────
// Estos correos funcionan como “bootstrap” inicial.
// Si el perfil no existe en Firestore, se crea automáticamente
// con rol admin para Alek/Cata y assistant para el asesor.
// ─────────────────────────────────────────────────────────

const BOOTSTRAP_USERS = {
  'alekcaballeromusic@gmail.com': {
    name: 'Alek',
    role: ROLES.ADMIN,
  },
  'catalina.medina.leal@gmail.com': {
    name: 'Catalina',
    role: ROLES.ADMIN,
  },
  'adminmusicala@gmail.com': {
    name: 'Admin Musicala',
    role: ROLES.ADMIN,
  },
  'musicalaasesor@gmail.com': {
    name: 'Asesor Musicala',
    role: ROLES.ASSISTANT,
  },
};

// ─────────────────────────────────────────────────────────
// Errores personalizados
// ─────────────────────────────────────────────────────────

export class AuthServiceError extends Error {
  constructor(message, code = 'auth/service-error') {
    super(message);
    this.name = 'AuthServiceError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────
// Utilidades internas
// ─────────────────────────────────────────────────────────

function normalizeEmail(email = '') {
  return String(email).trim().toLowerCase();
}

function getBootstrapProfile(email) {
  const normalizedEmail = normalizeEmail(email);
  const bootstrapUser = BOOTSTRAP_USERS[normalizedEmail];

  if (!bootstrapUser) return null;

  return {
    email: normalizedEmail,
    name: bootstrapUser.name,
    role: bootstrapUser.role,
    active: true,
  };
}

function isValidRole(role) {
  return role === ROLES.ADMIN || role === ROLES.ASSISTANT;
}

function normalizeProfile(profile = {}, user = null) {
  const email = normalizeEmail(profile.email || user?.email || '');

  return {
    uid: profile.uid || user?.uid || '',
    email,
    name:
      profile.name ||
      user?.displayName ||
      email.split('@')[0] ||
      'Usuario Musicala',
    role: isValidRole(profile.role) ? profile.role : ROLES.ASSISTANT,
    active: profile.active === true,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null,
  };
}

function getFriendlyAuthError(error) {
  const code = error?.code || '';

  const messages = {
    'auth/invalid-email': 'El correo no tiene un formato válido.',
    'auth/user-disabled': 'Esta cuenta está deshabilitada.',
    'auth/user-not-found': 'No existe una cuenta con ese correo.',
    'auth/wrong-password': 'La contraseña no es correcta.',
    'auth/invalid-credential': 'El correo o la contraseña no son correctos.',
    'auth/missing-password': 'Escribe la contraseña.',
    'auth/too-many-requests':
      'Hubo demasiados intentos. Espera un momento antes de volver a intentar.',
    'auth/network-request-failed':
      'Hay un problema de conexión. Revisa internet y vuelve a intentar.',
    'permission-denied':
      'No tienes permisos suficientes para consultar tu perfil.',
  };

  return messages[code] || 'No fue posible iniciar sesión. Revisa los datos e intenta nuevamente.';
}

async function findProfileByEmail(email) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) return null;

  const profilesRef = collection(db, COLLECTIONS.PROFILES);
  const q = query(
    profilesRef,
    where('email', '==', normalizedEmail),
    limit(1)
  );

  const snapshot = await getDocs(q);

  if (snapshot.empty) return null;

  const docSnap = snapshot.docs[0];

  return {
    id: docSnap.id,
    ...docSnap.data(),
  };
}

async function createBootstrapProfile(user, bootstrapProfile) {
  const profileRef = doc(db, COLLECTIONS.PROFILES, user.uid);

  const newProfile = {
    uid: user.uid,
    email: bootstrapProfile.email,
    name: bootstrapProfile.name,
    role: bootstrapProfile.role,
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await setDoc(profileRef, newProfile, { merge: true });

  return {
    ...newProfile,
    createdAt: null,
    updatedAt: null,
  };
}

// ─────────────────────────────────────────────────────────
// API pública del servicio
// ─────────────────────────────────────────────────────────

/**
 * Configura persistencia local para mantener la sesión abierta.
 * Conviene llamarlo al iniciar la app.
 */
export async function setupAuthPersistence() {
  await setPersistence(auth, browserLocalPersistence);
}

/**
 * Inicia sesión con correo y contraseña.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{user: import('firebase/auth').User, profile: Object}>}
 */
export async function login(email, password) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new AuthServiceError('Escribe tu correo electrónico.', 'auth/missing-email');
  }

  if (!password) {
    throw new AuthServiceError('Escribe tu contraseña.', 'auth/missing-password');
  }

  try {
    await setupAuthPersistence();

    const credential = await signInWithEmailAndPassword(
      auth,
      normalizedEmail,
      password
    );

    const user = credential.user;
    const profile = await loadAndValidateUserProfile(user);

    setState({
      currentUser: user,
      userProfile: profile,
    });

    return { user, profile };
  } catch (error) {
    // Si inició sesión pero falló la autorización, cerramos de una vez.
    if (auth.currentUser && error instanceof AuthServiceError) {
      await safeLogout();
    }

    if (error instanceof AuthServiceError) {
      throw error;
    }

    throw new AuthServiceError(getFriendlyAuthError(error), error?.code);
  }
}

/**
 * Cierra sesión y limpia el estado local.
 */
export async function logout() {
  await signOut(auth);

  setState({
    currentUser: null,
    userProfile: null,
    currentView: 'dashboard',
    allLeads: [],
    filteredLeads: [],
    currentPage: 1,
    currentLead: null,
  });
}

/**
 * Cierre de sesión seguro para usar internamente.
 * No lanza error si Firebase falla.
 */
export async function safeLogout() {
  try {
    await logout();
  } catch (error) {
    console.warn('[auth.service] No se pudo cerrar sesión limpiamente:', error);
  }
}

/**
 * Escucha los cambios de autenticación.
 * Úsalo en app.js para decidir si mostrar login o app.
 *
 * @param {Function} callback
 * @returns {Function} unsubscribe
 */
export function listenAuthState(callback) {
  return onAuthStateChanged(auth, async (user) => {
    try {
      if (!user) {
        setState({
          currentUser: null,
          userProfile: null,
        });

        callback?.({
          status: 'signed-out',
          user: null,
          profile: null,
        });

        return;
      }

      const profile = await loadAndValidateUserProfile(user);

      setState({
        currentUser: user,
        userProfile: profile,
      });

      callback?.({
        status: 'signed-in',
        user,
        profile,
      });
    } catch (error) {
      console.error('[auth.service] Error validando sesión:', error);

      await safeLogout();

      callback?.({
        status: 'error',
        user: null,
        profile: null,
        error:
          error instanceof AuthServiceError
            ? error
            : new AuthServiceError(getFriendlyAuthError(error), error?.code),
      });
    }
  });
}

/**
 * Carga y valida el perfil del usuario autenticado.
 * 1. Busca profiles/{uid}
 * 2. Si no existe, busca profiles por email
 * 3. Si tampoco existe, valida si está en BOOTSTRAP_USERS
 * 4. Si está en bootstrap, crea perfil automáticamente
 * 5. Si no está autorizado o está inactivo, bloquea acceso
 *
 * @param {import('firebase/auth').User} user
 * @returns {Promise<Object>}
 */
export async function loadAndValidateUserProfile(user) {
  if (!user?.uid || !user?.email) {
    throw new AuthServiceError(
      'No se pudo identificar el usuario autenticado.',
      'auth/invalid-user'
    );
  }

  const normalizedEmail = normalizeEmail(user.email);
  const profileRef = doc(db, COLLECTIONS.PROFILES, user.uid);
  const profileSnap = await getDoc(profileRef);

  let rawProfile = null;

  if (profileSnap.exists()) {
    rawProfile = {
      id: profileSnap.id,
      ...profileSnap.data(),
    };
  }

  // Fallback: buscar perfil por email si no existe con UID.
  if (!rawProfile) {
    rawProfile = await findProfileByEmail(normalizedEmail);
  }

  // Bootstrap: permitir crear perfil inicial solo para correos conocidos.
  if (!rawProfile) {
    const bootstrapProfile = getBootstrapProfile(normalizedEmail);

    if (!bootstrapProfile) {
      throw new AuthServiceError(
        'Tu correo no está autorizado para ingresar a esta herramienta.',
        'auth/not-authorized'
      );
    }

    try {
      rawProfile = await createBootstrapProfile(user, bootstrapProfile);
    } catch (error) {
      console.warn(
        '[auth.service] No se pudo crear el perfil bootstrap. Se usará perfil local temporal:',
        error
      );

      // Esto permite entrar aunque las reglas todavía no dejen crear profiles.
      // Peeero: para usar Firestore bien, luego hay que crear el perfil o ajustar reglas.
      rawProfile = {
        uid: user.uid,
        ...bootstrapProfile,
      };
    }
  }

  const profile = normalizeProfile(rawProfile, user);

  if (profile.email !== normalizedEmail) {
    throw new AuthServiceError(
      'El perfil encontrado no coincide con el correo autenticado.',
      'auth/profile-email-mismatch'
    );
  }

  if (!profile.active) {
    throw new AuthServiceError(
      'Tu usuario existe, pero está inactivo. Pide a un administrador que lo active.',
      'auth/user-inactive'
    );
  }

  if (!isValidRole(profile.role)) {
    throw new AuthServiceError(
      'Tu usuario no tiene un rol válido asignado.',
      'auth/invalid-role'
    );
  }

  return profile;
}

/**
 * Devuelve el usuario Firebase actual.
 */
export function getCurrentUser() {
  return auth.currentUser;
}

/**
 * Devuelve true si hay usuario autenticado.
 */
export function isAuthenticated() {
  return Boolean(auth.currentUser);
}

/**
 * Devuelve true si el perfil es administrador.
 * @param {Object} profile
 */
export function isAdmin(profile) {
  return profile?.role === ROLES.ADMIN;
}

/**
 * Devuelve true si el perfil es asesor/asistente.
 * @param {Object} profile
 */
export function isAssistant(profile) {
  return profile?.role === ROLES.ASSISTANT;
}

/**
 * Valida permiso de administrador.
 * Útil antes de permitir importar archivos.
 * @param {Object} profile
 */
export function requireAdmin(profile) {
  if (!isAdmin(profile)) {
    throw new AuthServiceError(
      'Solo un usuario administrador puede realizar esta acción.',
      'auth/admin-required'
    );
  }

  return true;
}

/**
 * Mapa público para mostrar errores amigables desde app.js.
 */
export function parseAuthError(error) {
  if (error instanceof AuthServiceError) {
    return error.message;
  }

  return getFriendlyAuthError(error);
}
