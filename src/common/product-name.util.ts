const clean = (value: unknown) => String(value ?? '').trim();

const canonicalWatchLine = (value: unknown) => {
  const raw = clean(value).replace(/^apple\s+watch\s*/i, '').trim();
  if (/^normal$/i.test(raw)) return 'Series';
  if (/^series(?:\s|$)/i.test(raw)) return raw.replace(/^series/i, 'Series');
  if (/^se(?:\s|$)/i.test(raw)) return raw.replace(/^se/i, 'SE');
  if (/^ultra(?:\s|$)/i.test(raw)) return raw.replace(/^ultra/i, 'Ultra');
  return raw;
};

export const formatAppleWatchModel = (detail: Record<string, any> = {}) => {
  const rawLine = detail.gama || detail.linea || detail.tipoWatch || detail.modelo;
  const line = canonicalWatchLine(rawLine);
  const generation = canonicalWatchLine(detail.generacion || detail.serie);

  if (/^(Series|SE|Ultra)(?:\s|$)/i.test(generation)) return generation;
  if (line && generation && line.toLowerCase().endsWith(` ${generation.toLowerCase()}`)) return line;
  if (line) return generation ? `${line} ${generation}` : line;
  if (generation) return /^\d+$/.test(generation) ? `Series ${generation}` : generation;
  return '';
};

export const formatAppleWatchName = (detail: Record<string, any> = {}) => {
  const model = formatAppleWatchModel(detail);

  const rawSize = clean(detail.tamano ?? detail.tamanio ?? detail['tama\u00f1o']);
  const size = /^\d+(?:[.,]\d+)?$/.test(rawSize) ? `${rawSize} mm` : rawSize;
  const connection = clean(detail.conexion ?? detail.conectividad);

  return ['Apple Watch', model, size, connection].map(clean).filter(Boolean).join(' ');
};
