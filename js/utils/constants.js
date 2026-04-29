// ─────────────────────────────────────────────────────────
// constants.js — Constantes globales de la app
// ─────────────────────────────────────────────────────────

// Colecciones de Firestore
export const COLLECTIONS = {
  PROFILES:     'profiles',
  KEYBE_LEADS:  'keybeLeads',
  LEAD_MESSAGES: 'messages',
};

// Roles de usuario
export const ROLES = {
  ADMIN:     'admin',
  ASSISTANT: 'assistant',
};

// Estados de revisión (valor interno → etiqueta en español)
export const REVISION_STATUS = {
  pendiente_revision: 'Pendiente por revisar',
  ya_esta_en_base:    'Ya está en base oficial',
  no_esta_en_base:    'No está en base oficial',
  debe_contactarse:   'Debe contactarse',
  duplicado:          'Duplicado',
  descartado:         'Descartado',
  matriculado:        'Matriculado',
};

export const REVISION_STATUS_KEYS = Object.keys(REVISION_STATUS);

// Responsables
export const RESPONSABLES = [
  'Sin asignar',
  'Catalina Medina',
  'Alek Caballero',
  'Camila Rodríguez',
  'Liceth Rincón',
];

// Canales
export const CHANNELS = {
  whatsapp:  'WhatsApp',
  instagram: 'Instagram',
  facebook:  'Facebook',
  web:       'Web',
  otro:      'Otro',
};

// Intereses detectables
export const INTERESTS = {
  MUSICA:              'Música',
  DANZA:               'Danza',
  TEATRO:              'Teatro',
  ARTES_PLASTICAS:     'Artes plásticas',
  INFO_COMERCIAL:      'Información comercial',
  SIN_CLASIFICAR:      'Sin clasificar',
};

// Palabras clave por interés
export const INTEREST_KEYWORDS = {
  [INTERESTS.MUSICA]: [
    'piano', 'guitarra', 'canto', 'batería', 'violín', 'violin',
    'música', 'musica', 'flauta', 'saxofón', 'saxofon', 'trompeta',
    'ukulele', 'bajo', 'coro', 'instrumento',
  ],
  [INTERESTS.DANZA]: [
    'danza', 'baile', 'ballet', 'porras', 'porrismo',
    'contemporáneo', 'contemporaneo', 'salsa', 'ritmo',
  ],
  [INTERESTS.TEATRO]: [
    'teatro', 'actuación', 'actuacion', 'dramaturgia', 'escena',
    'actuando', 'obras', 'escenario',
  ],
  [INTERESTS.ARTES_PLASTICAS]: [
    'artes', 'pintura', 'dibujo', 'plasticas', 'plásticas',
    'escultura', 'ilustración', 'ilustracion', 'arte',
  ],
  [INTERESTS.INFO_COMERCIAL]: [
    'precios', 'horarios', 'mensualidad', 'matrícula', 'matricula',
    'clase de prueba', 'información', 'informacion', 'costo',
    'valor', 'inscripción', 'inscripcion', 'tarifa',
  ],
};

// Paginación
export const PAGE_SIZE = 25;

// Fuente de datos
export const SOURCE_KEYBE = 'keybe';
