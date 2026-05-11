// excel.utils.js - Lectura local de CSV/XLSX preservando telefonos reales.
// Ojo con esta vuelta: Excel muestra numeros largos como 5.73507E+11 y ese display
// redondeado destruye los ultimos digitos. Por eso para telefonos usamos cell.v,
// no cell.w, salvo que el display sea claramente mejor y NO sea notacion cientifica.

export function readExcelFile(file) {
  return new Promise((resolve, reject) => {
    if (!window.XLSX) {
      reject(new Error('SheetJS (XLSX) no esta cargado.'));
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'csv') {
          resolve(readCsvText(e.target.result));
          return;
        }

        const data = new Uint8Array(e.target.result);
        const workbook = window.XLSX.read(data, {
          type: 'array',
          cellDates: true,
          raw: true,
        });

        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(sheet, {
          defval: '',
          raw: true,
          blankrows: false,
        });

        resolve(rows.map(restoreExactValuesFromSheet(sheet)));
      } catch (err) {
        reject(new Error(`Error al leer el archivo "${file.name}": ${err.message}`));
      }
    };

    reader.onerror = () => reject(new Error(`No se pudo leer el archivo "${file.name}".`));
    if (file.name.toLowerCase().endsWith('.csv')) reader.readAsText(file, 'utf-8');
    else reader.readAsArrayBuffer(file);
  });
}

export function validateColumns(rows, requiredColumns) {
  if (!rows || rows.length === 0) return { valid: false, missing: requiredColumns };

  const firstRow = rows[0];
  const available = Object.keys(firstRow).map((k) => k.trim().toLowerCase());
  const missing = requiredColumns.filter((col) => !available.includes(col.trim().toLowerCase()));
  return { valid: missing.length === 0, missing };
}

export function normalizeRowKeys(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key.trim().toLowerCase()] = value;
  }
  return normalized;
}

function restoreExactValuesFromSheet(sheet) {
  const range = window.XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const headers = [];

  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = sheet[window.XLSX.utils.encode_cell({ r: range.s.r, c })];
    headers.push(String(cell?.v ?? cell?.w ?? '').trim());
  }

  return (row, index) => {
    const out = { ...row };
    const excelRow = range.s.r + 1 + index;

    headers.forEach((header, c) => {
      if (!header) return;
      const cell = sheet[window.XLSX.utils.encode_cell({ r: excelRow, c })];
      if (!cell) return;

      if (isPhoneHeader(header)) {
        out[header] = readPhoneCellValue(cell);
        return;
      }

      if (cell.w && shouldPreferDisplayValue(header, cell.v, cell.w)) {
        out[header] = cell.w;
      }
    });

    return out;
  };
}

function isPhoneHeader(header) {
  const h = String(header || '').trim().toLowerCase();
  return (
    h === 'phone' ||
    h === 'telefono' ||
    h === 'teléfono' ||
    h === 'tel' ||
    h === 'celular' ||
    h === 'mobile' ||
    h === 'user_phone' ||
    h === 'userphone' ||
    h.includes('phone') ||
    h.includes('telefono') ||
    h.includes('teléfono')
  );
}

function readPhoneCellValue(cell) {
  const raw = valueToPlainText(cell?.v);
  const display = valueToPlainText(cell?.w);

  const rawDigits = onlyDigits(raw);
  const displayDigits = onlyDigits(display);

  // Caso clave: cell.w puede venir como 5.73507E+11. Eso ya viene redondeado.
  // Si usamos ese display, nacen maravillas humanas como 3507000000. No gracias.
  if (rawDigits.length >= 10 && !isUnsafeRoundedScientific(raw)) return raw;

  // Si el display conserva mas informacion y no es notacion cientifica, puede servir
  // para casos escritos como +57 300 123 4567.
  if (
    displayDigits.length >= 10 &&
    !isScientificNotation(display) &&
    displayDigits.length >= rawDigits.length
  ) {
    return display;
  }

  return raw || display || '';
}

function valueToPlainText(value) {
  if (value === null || value === undefined) return '';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';

    // Los telefonos colombianos +57 tienen 12 digitos, estan muy por debajo
    // del limite seguro de enteros de JS. Convertimos a texto sin agrupadores.
    if (Number.isSafeInteger(value)) return String(value);

    return value.toLocaleString('fullwide', {
      useGrouping: false,
      maximumFractionDigits: 0,
    });
  }

  return String(value).trim();
}

function shouldPreferDisplayValue(header, rawValue, displayValue) {
  if (isPhoneHeader(header)) return false;
  if (!displayValue) return false;
  if (isScientificNotation(displayValue)) return false;

  // Para otros campos numericos grandes, se puede preferir el display solo si no
  // esta en notacion cientifica. En telefonos esto queda prohibido arriba.
  return typeof rawValue === 'number' && Math.abs(rawValue) >= 1000000000;
}

function isScientificNotation(value) {
  return /^[+-]?\d+(?:[\.,]\d+)?e[+-]?\d+$/i.test(String(value || '').trim().replace(/\s+/g, ''));
}

function isUnsafeRoundedScientific(value) {
  const text = String(value || '').trim().replace(',', '.').replace(/\s+/g, '');
  const match = text.match(/^[+-]?(\d+)(?:\.(\d+))?e[+-]?\d+$/i);
  if (!match) return false;

  const significantDigits = `${match[1] || ''}${match[2] || ''}`.replace(/^0+/, '').length;
  return significantDigits > 0 && significantDigits < 10;
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function readCsvText(text) {
  const workbook = window.XLSX.read(text, { type: 'string', raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(sheet, {
    defval: '',
    raw: true,
    blankrows: false,
  });
}
