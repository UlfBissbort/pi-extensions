// Makes captured model contexts comparable across runs: volatile times and
// temporary paths are replaced; presence of each field is preserved.
export function normalizeContext(value, dir) {
  const walk = (v, key) => {
    if (typeof v === 'string') return (key === 'preamble' ? '<PREAMBLE>' : v.split(dir).join('<DIR>'));
    if (typeof v === 'number' && (key === 'timestamp' || key === 'durationMs')) return 0;
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(JSON.parse(JSON.stringify(value)));
}
