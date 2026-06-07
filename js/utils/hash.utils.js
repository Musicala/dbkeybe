export function stableStringify(value) {
  return JSON.stringify(normalizeForHash(value));
}

export function hashText(text) {
  let hash = 5381;
  const str = String(text || '');
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

export function hashObject(value) {
  return hashText(stableStringify(value));
}

function normalizeForHash(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (typeof value !== 'object') return value;

  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      if (typeof value[key] === 'function') return acc;
      acc[key] = normalizeForHash(value[key]);
      return acc;
    }, {});
}
