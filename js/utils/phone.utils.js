// phone.utils.js - Normalizacion robusta de telefonos Keybe.

export function normalizePhone(value) {
  const raw = normalizeRawInput(value);
  const result = {
    raw,
    digits: '',
    local: '',
    normalized: '',
    e164: '',
    isValidPhone: false,
    countryCode: '',
    reason: raw ? 'invalidPhone' : 'empty',
    recoveredFromScientificNotation: false,
    possibleRoundedScientificNotation: false,
    isPlatformId: false,
  };

  if (!raw) return result;

  const sci = expandScientificNotation(raw);
  result.recoveredFromScientificNotation = sci.recovered;
  result.possibleRoundedScientificNotation = sci.possiblyRounded;

  if (sci.possiblyRounded) {
    result.reason = 'roundedScientificNotation';
    return result;
  }

  let digits = sci.value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  result.digits = digits;

  if (!digits) {
    result.reason = 'noDigits';
    return result;
  }

  if (digits.length > 14) {
    result.reason = 'platformId';
    result.isPlatformId = true;
    return result;
  }

  let local = '';
  let countryCode = '';

  if (digits.length === 10 && digits.startsWith('3')) {
    local = digits;
    countryCode = '57';
  } else if (digits.length === 12 && digits.startsWith('573')) {
    local = digits.slice(2);
    countryCode = '57';
  } else if (digits.length === 13 && digits.startsWith('0573')) {
    local = digits.slice(3);
    countryCode = '57';
  } else if (digits.length === 14 && digits.startsWith('00573')) {
    local = digits.slice(4);
    countryCode = '57';
  } else if (digits.length >= 11 && digits.length <= 14 && !digits.startsWith('57')) {
    result.reason = 'possiblePlatformId';
    result.isPlatformId = digits.length >= 13;
    return result;
  }

  if (local && local.length === 10 && local.startsWith('3')) {
    result.local = local;
    result.normalized = local;
    result.e164 = `+57${local}`;
    result.countryCode = countryCode;
    result.isValidPhone = true;
    result.reason = result.recoveredFromScientificNotation ? 'recoveredScientificNotation' : 'validCoMobile';
    return result;
  }

  result.reason = digits.length >= 13 ? 'platformId' : 'invalidCoMobile';
  result.isPlatformId = digits.length >= 13;
  return result;
}

export function normalizePhoneString(value) {
  return normalizePhone(value).local;
}

export function isSamePhone(a, b) {
  const pa = normalizePhone(a);
  const pb = normalizePhone(b);
  return pa.isValidPhone && pb.isValidPhone && pa.local === pb.local;
}

export function displayPhone(value) {
  const parsed = typeof value === 'object' && value !== null ? value : normalizePhone(value);
  const d = parsed.local || parsed.normalized || String(value || '').replace(/\D/g, '');
  if (!d) return '-';
  if (d.length === 10) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return d;
}

export function whatsappLink(value) {
  const parsed = normalizePhone(value);
  return parsed.isValidPhone ? `https://wa.me/57${parsed.local}` : null;
}

function normalizeRawInput(value) {
  if (value == null) return '';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    if (Number.isSafeInteger(value)) return String(value);
    return value.toLocaleString('fullwide', {
      useGrouping: false,
      maximumFractionDigits: 0,
    });
  }

  return String(value).trim();
}

function expandScientificNotation(value) {
  const text = String(value ?? '').trim();
  const normalized = text.replace(',', '.').replace(/\s+/g, '');

  const match = normalized.match(/^([+-]?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);
  if (!match) return { value: text, recovered: false, possiblyRounded: false };

  const [, sign, intPartRaw, decimalPartRaw = '', exponentRaw] = match;
  const significantDigits = `${intPartRaw}${decimalPartRaw}`.replace(/^0+/, '').length;

  // Si la mantisa trae muy pocos digitos, viene redondeada por Excel
  // y no podemos reconstruir los ultimos numeros reales.
  if (significantDigits > 0 && significantDigits < 10) {
    return { value: text, recovered: true, possiblyRounded: true };
  }

  const exponent = Number(exponentRaw);
  if (!Number.isFinite(exponent)) return { value: text, recovered: false, possiblyRounded: false };

  const negative = sign === '-';
  const intPart = intPartRaw.replace(/\D/g, '');
  const decimalPart = decimalPartRaw.replace(/\D/g, '');
  const digits = `${intPart}${decimalPart}`;
  const decimalPlaces = decimalPart.length;
  const shift = exponent - decimalPlaces;
  const expanded = shift >= 0
    ? digits + '0'.repeat(shift)
    : `${digits.slice(0, shift) || '0'}.${digits.slice(shift)}`;

  return { value: `${negative ? '-' : ''}${expanded}`, recovered: true, possiblyRounded: false };
}
