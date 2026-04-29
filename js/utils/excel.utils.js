// ─────────────────────────────────────────────────────────
// excel.utils.js — Lectura de archivos Excel con SheetJS
// Los archivos NUNCA se suben; se leen solo en el navegador.
// ─────────────────────────────────────────────────────────

/**
 * Lee un archivo .xlsx/.xls y retorna un array de objetos JSON
 * (una entrada por fila, usando la primera fila como encabezados).
 *
 * @param {File} file — objeto File del input[type=file]
 * @returns {Promise<Object[]>}
 */
export function readExcelFile(file) {
  return new Promise((resolve, reject) => {
    if (!window.XLSX) {
      reject(new Error('SheetJS (XLSX) no está cargado. Verifica la conexión a internet.'));
      return;
    }

    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data     = new Uint8Array(e.target.result);
        const workbook = window.XLSX.read(data, { type: 'array', cellDates: true });

        // Tomar la primera hoja
        const sheetName = workbook.SheetNames[0];
        const sheet     = workbook.Sheets[sheetName];

        // Convertir a JSON
        const rows = window.XLSX.utils.sheet_to_json(sheet, {
          defval: '',       // valor por defecto para celdas vacías
          raw:    false,    // convertir fechas a string ISO
        });

        resolve(rows);
      } catch (err) {
        reject(new Error(`Error al leer el archivo "${file.name}": ${err.message}`));
      }
    };

    reader.onerror = () => reject(new Error(`No se pudo leer el archivo "${file.name}".`));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Valida que un array de filas tenga al menos las columnas esperadas.
 *
 * @param {Object[]} rows
 * @param {string[]} requiredColumns
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateColumns(rows, requiredColumns) {
  if (!rows || rows.length === 0) {
    return { valid: false, missing: requiredColumns };
  }

  const firstRow = rows[0];
  const available = Object.keys(firstRow).map((k) => k.trim().toLowerCase());
  const missing   = requiredColumns.filter(
    (col) => !available.includes(col.trim().toLowerCase())
  );

  return { valid: missing.length === 0, missing };
}

/**
 * Normaliza las claves de un objeto de fila (trim + lowercase).
 * Útil para manejar variaciones de encabezados.
 */
export function normalizeRowKeys(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key.trim().toLowerCase()] = value;
  }
  return normalized;
}
