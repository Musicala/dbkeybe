// ─────────────────────────────────────────────────────────
// firebase.config.js
// Configuración Firebase para Musicala Verificador Keybe
// No subir a repositorios públicos si no se ha configurado
// correctamente .gitignore o variables de entorno.
// ─────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth }       from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore }  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey:            "AIzaSyC_hSoMyT5udUKrc287GPaqzvmajZLP39Y",
  authDomain:        "base-de-datos-keybe.firebaseapp.com",
  projectId:         "base-de-datos-keybe",
  storageBucket:     "base-de-datos-keybe.firebasestorage.app",
  messagingSenderId: "777005067102",
  appId:             "1:777005067102:web:de2b21de242dbe6e74fdcf"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

export { app, auth, db };
