# Musicala Verificador Keybe

Herramienta interna de revisión y conciliación de contactos exportados desde Keybe.

---

## ¿Qué hace esta app?

Permite verificar qué contactos de Keybe ya están en la base oficial de Musicala, cuáles faltan, cuáles deben contactarse y cuáles son duplicados. **No modifica los archivos originales de Keybe.**

---

## Tecnologías

- HTML + CSS + JavaScript vanilla (ES Modules)
- Firebase Authentication (correo/contraseña)
- Cloud Firestore
- SheetJS para leer Excel en el navegador

---

## Estructura de archivos

```
Base de datos Keybe/
  index.html
  firebase.json
  firestore.rules
  firestore.indexes.json
  css/
    styles.css
  js/
    app.js
    config/firebase.config.js
    services/
      auth.service.js
      firestore.service.js
      import.service.js
      export.service.js
    ui/
      auth.ui.js
      dashboard.ui.js
      leads.ui.js
      lead-detail.ui.js
      import.ui.js
      toast.ui.js
    utils/
      constants.js
      state.js
      formatters.js
      phone.utils.js
      interest.utils.js
      excel.utils.js
```

---

## Configuración Firebase (resumen)

### 1. Authentication
- Activar proveedor: **Correo electrónico/Contraseña**
- Crear 3 usuarios manualmente en la consola de Firebase

### 2. Firestore
- Crear base de datos en modo **Producción**
- Pegar las reglas de `firestore.rules`

### 3. Perfiles (crear manualmente en Firestore)
Colección: `profiles` — el ID del documento es el UID del usuario en Firebase Auth.

```json
{
  "email": "alekcaballeromusic@gmail.com",
  "displayName": "Alek",
  "role": "admin",
  "active": true
}
```

```json
{
  "email": "catalina.medina.leal@gmail.com",
  "displayName": "Catalina",
  "role": "admin",
  "active": true
}
```

```json
{
  "email": "adminmusicala@gmail.com",
  "displayName": "Admin Musicala",
  "role": "admin",
  "active": true
}
```

```json
{
  "email": "musicalaasesor@gmail.com",
  "displayName": "Asesor Musicala",
  "role": "assistant",
  "active": true
}
```

---

## Cómo usar

### Ejecución local
Abre con Live Server (VS Code) sobre `index.html`.  
No abrir directamente como archivo (`file://`) porque los ES modules y Firebase requieren servidor HTTP.

### Importar datos
1. Inicia sesión con una cuenta de **admin**
2. Ve a **Importar datos Keybe**
3. Carga `Musicala.contacts.xlsx` y `Musicala.messages.xlsx`
4. Revisa la vista previa y haz clic en **Procesar e importar**

### Revisión de contactos
1. Ve a **Contactos**
2. Filtra por estado, responsable, canal o interés
3. Haz clic en **Ver** para abrir la ficha
4. Actualiza el estado, responsable y nota, luego guarda

### Exportar CSV
En la sección **Contactos**, usa el botón **Exportar CSV** para generar un respaldo.

---

## Seguridad

- Los archivos Excel **nunca se suben** al servidor ni a Firebase Storage
- Solo se procesan en memoria del navegador
- Firestore está protegido con reglas que requieren autenticación y perfil activo
- Los asistentes solo pueden modificar campos de revisión, no datos de Keybe

---

## Notas importantes

- No subir los archivos `.xlsx` al repositorio (están en `.gitignore` conceptualmente)
- No compartir `firebase.config.js` en repositorios públicos
- Si un usuario no tiene documento en `profiles`, la sesión se cierra automáticamente
