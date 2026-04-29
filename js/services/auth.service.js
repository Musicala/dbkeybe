import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { auth, db } from '../config/firebase.config.js';
import { setState } from '../utils/state.js';
import { COLLECTIONS, ROLES } from '../utils/constants.js';

const BOOTSTRAP_USERS = {
  'alekcaballeromusic@gmail.com': {
    name: 'Alek',
    role: ROLES.ADMIN,
  },
  'catalina.medina.leal@gmail.com': {
    name: 'Catalina',
    role: ROLES.ADMIN,
  },
  'musicalaasesor@gmail.com': {
    name: 'Asesor Musicala',
    role: ROLES.ASSISTANT,
  },
};

function normalizeEmail(email = '') {
  return String(email).trim().toLowerCase();
}

function getBootstrapProfile(email) {
  return BOOTSTRAP_USERS[normalizeEmail(email)] || null;
}

export async function loginWithGoogle() {
  try {
    await setPersistence(auth, browserLocalPersistence);

    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    const credential = await signInWithPopup(auth, provider);
    const profile = await fetchUserProfile(credential.user.uid, credential.user);
    return { user: credential.user, profile };
  } catch (err) {
    throw new Error(translateAuthError(err.code));
  }
}

export async function logout() {
  await signOut(auth);
  setState({ currentUser: null, userProfile: null });
}

export async function fetchUserProfile(uid, user = auth.currentUser) {
  const ref = doc(db, COLLECTIONS.PROFILES, uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    const bootstrapProfile = getBootstrapProfile(user?.email);

    if (!bootstrapProfile) {
      await signOut(auth);
      throw new Error('Tu cuenta no tiene acceso autorizado a esta aplicacion.');
    }

    const profileData = {
      uid,
      email: normalizeEmail(user.email),
      name: bootstrapProfile.name || user.displayName || user.email,
      role: bootstrapProfile.role,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(ref, profileData, { merge: true });

    return {
      id: uid,
      ...profileData,
      createdAt: null,
      updatedAt: null,
    };
  }

  const profile = snap.data();

  if (!profile.active) {
    await signOut(auth);
    throw new Error('Tu cuenta esta desactivada. Contacta al administrador.');
  }

  return { id: snap.id, ...profile };
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

function translateAuthError(code) {
  const errors = {
    'auth/account-exists-with-different-credential': 'Ese correo ya esta vinculado a otro metodo de acceso.',
    'auth/popup-closed-by-user': 'Se cerro la ventana de Google antes de completar el ingreso.',
    'auth/popup-blocked': 'El navegador bloqueo la ventana de Google. Permite ventanas emergentes e intenta de nuevo.',
    'auth/cancelled-popup-request': 'Ya hay una ventana de ingreso abierta.',
    'auth/unauthorized-domain': 'Este dominio no esta autorizado en Firebase Authentication.',
    'auth/too-many-requests': 'Demasiados intentos fallidos. Intenta de nuevo mas tarde.',
    'auth/user-disabled': 'Esta cuenta ha sido desactivada.',
    'auth/network-request-failed': 'Error de red. Verifica tu conexion a internet.',
    'permission-denied': 'No tienes permisos suficientes en Firestore. Revisa las reglas publicadas.',
  };

  return errors[code] || 'Error al iniciar sesion con Google. Intenta de nuevo.';
}
