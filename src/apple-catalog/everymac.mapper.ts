// Convierte fichas EveryMac (una por configuración/variante) en entradas del dataset por modelo comercial
// (gama + procesador para Mac; generación/chip para iPad; serie para Watch; número+modelo para iPhone).
import type { CatalogTipo, Connectivity, DatasetModelEntry, MacCombo, Provenance, SpecsDataset } from './apple-catalog.types';
import { slug } from './appledb.normalizer';
import { CONNECTIVITY_VALUE } from './device-capabilities';
import type { EveryMacRecord } from './everymac.parser';

const uniq = <T>(items: T[]) => Array.from(new Set(items));
const sizeValue = (value: string) => (/TB$/.test(value) ? parseFloat(value) * 1024 : parseFloat(value));
const sortSizes = (values: string[]) => uniq(values).sort((a, b) => sizeValue(a) - sizeValue(b));

export interface MappedModel {
  id: string;
  tipo: CatalogTipo;
  title: string;
  detalle: Record<string, string>;
}

/**
 * Identidad comercial de una ficha. `knownIds` permite reutilizar el ID que ya usa AppleDB/dataset
 * cuando el modelo existe (p. ej. iPad 11.ª gen = `ipad-a16`).
 */
export function mapRecordToModel(record: EveryMacRecord, knownIds: Set<string> = new Set()): MappedModel | null {
  const pick = (candidates: string[]) => candidates.find((id) => knownIds.has(id)) || candidates[0];
  const chip = record.chip || '';
  switch (record.tipo) {
    case 'macbook': {
      const gama = record.gama || 'Pro';
      if (!chip) return null;
      return { id: `macbook-${slug(gama)}-${slug(chip)}`, tipo: 'macbook', title: `MacBook ${gama} (${chip})`, detalle: { gama, procesador: chip } };
    }
    case 'imac':
    case 'macmini': {
      if (!chip) return null;
      const label = record.tipo === 'imac' ? 'iMac' : 'Mac mini';
      return { id: `${record.tipo}-${slug(chip)}`, tipo: record.tipo, title: `${label} (${chip})`, detalle: { procesador: chip } };
    }
    case 'ipad': {
      const gama = record.gama || 'Normal';
      const gen = record.generation;
      if (gama === 'Air' || gama === 'Pro') {
        if (!chip) return null;
        return { id: pick([`ipad-${slug(gama)}-${slug(chip)}`]), tipo: 'ipad', title: `iPad ${gama} (${chip})`, detalle: { gama, procesador: chip } };
      }
      const prefix = gama === 'Mini' ? 'ipad-mini-' : 'ipad-';
      const candidates = uniq([gen ? `${prefix}${gen}` : '', chip ? `${prefix}${slug(chip)}` : ''].filter(Boolean));
      if (!candidates.length) return null;
      const label = gama === 'Mini' ? 'iPad mini' : 'iPad';
      return { id: pick(candidates), tipo: 'ipad', title: `${label} (${gen ? `${gen}.ª gen.` : chip})`, detalle: { gama, generacion: gen || chip } };
    }
    case 'watch': {
      if (!record.gama || !record.generation) return null;
      const title = record.gama === 'Ultra' && record.generation === '1' ? 'Apple Watch Ultra' : `Apple Watch ${record.gama} ${record.generation}`;
      return { id: `watch-${slug(record.gama)}-${record.generation}`, tipo: 'watch', title, detalle: { gama: record.gama, generacion: record.generation } };
    }
    case 'iphone': {
      if (!record.iphone) return null;
      const { numero, modelo } = record.iphone;
      const name = numero ? `iPhone ${numero}${modelo === 'E' ? 'e' : modelo === 'Normal' ? '' : modelo === 'Mini' ? ' mini' : ` ${modelo}`}` : `iPhone ${modelo}`;
      return { id: `iphone-${slug(numero || 'x')}-${slug(modelo)}`, tipo: 'iphone', title: name, detalle: { numero, modelo } };
    }
    default:
      return null;
  }
}

/** Agrupa las fichas por modelo y construye una entrada de dataset por modelo con procedencia EveryMac. */
export function recordsToDatasetEntries(records: EveryMacRecord[], knownIds: Set<string> = new Set()): { entries: DatasetModelEntry[]; skipped: Array<{ url: string; reason: string }> } {
  const groups = new Map<string, { model: MappedModel; records: EveryMacRecord[] }>();
  const skipped: Array<{ url: string; reason: string }> = [];
  for (const record of records) {
    const model = mapRecordToModel(record, knownIds);
    if (!model) {
      skipped.push({ url: record.url, reason: record.warnings.join(' ') || 'No se pudo identificar el modelo comercial.' });
      continue;
    }
    const group = groups.get(model.id) || { model, records: [] };
    group.records.push(record);
    groups.set(model.id, group);
  }

  const entries: DatasetModelEntry[] = [];
  for (const group of groups.values()) {
    // Fichas que no enumeran los SSD configurables toman los del mismo chip en otras fichas (desde su mínimo).
    group.records = group.records.map((r) => {
      if (!r.storageIncomplete) return r;
      const min = Math.min(...r.storageStandard.map(sizeValue));
      const siblings = group.records.filter((o) => o !== r && !o.storageIncomplete && o.chip === r.chip).flatMap((o) => o.storageOptions);
      return { ...r, storageOptions: sortSizes([...r.storageOptions, ...siblings.filter((v) => sizeValue(v) >= min)]) };
    });
  }
  for (const { model, records: recs } of groups.values()) {
    const latest = recs.map((r) => r.fetchedAt).sort().slice(-1)[0];
    const provenance: Provenance = {
      source: 'everymac',
      url: recs[0].url,
      verifiedAt: latest?.slice(0, 10),
      note: `${recs.length} ficha(s) EveryMac: ${recs.map((r) => r.url).join(' ')}`,
    };
    const entry: DatasetModelEntry = { id: model.id, tipo: model.tipo, title: model.title, detalle: model.detalle };
    const screens = new Map<string, string | undefined>();
    for (const r of recs) if (r.screen) screens.set(r.screen, screens.get(r.screen) || r.displayDiagonal || undefined);

    if (model.tipo === 'macbook' || model.tipo === 'imac' || model.tipo === 'macmini') {
      // Un bloque por ficha (chip/núcleos + tamaño): evita habilitar combinaciones que Apple no vende.
      const combos: MacCombo[] = [];
      for (const r of recs) {
        if (!r.ramOptions.length || !r.storageOptions.length) continue;
        const combo: MacCombo = { ram: r.ramOptions, almacenamiento: r.storageOptions, ...(r.screen && model.tipo !== 'macmini' ? { tamano: [r.screen] } : {}) };
        const key = JSON.stringify(combo);
        if (!combos.some((c) => JSON.stringify(c) === key)) combos.push(combo);
      }
      if (combos.length) entry.macCombos = { value: combos, provenance };
      if (screens.size && model.tipo !== 'macmini') entry.screens = { value: [...screens].sort((a, b) => Number(a[0]) - Number(b[0])).map(([value, diagonal]) => ({ value, ...(diagonal ? { diagonal } : {}) })), provenance };
      const weights: Record<string, number> = {};
      for (const r of recs) if (r.weightKg) weights[model.tipo === 'macbook' && r.screen ? r.screen : 'default'] = r.weightKg;
      if (Object.keys(weights).length) entry.weightKg = { value: weights, provenance };
    } else if (model.tipo === 'ipad') {
      if (screens.size) entry.screens = { value: [...screens].sort((a, b) => Number(a[0]) - Number(b[0])).map(([value, diagonal]) => ({ value, ...(diagonal ? { diagonal } : {}) })), provenance };
      const storages = sortSizes(recs.flatMap((r) => r.storageOptions));
      if (storages.length) entry.storages = { value: storages, provenance };
      const conn = uniq(recs.map((r) => r.connectivity).filter(Boolean)) as Connectivity[];
      if (conn.length) entry.connectivity = { value: conn, provenance };
    } else if (model.tipo === 'iphone') {
      const storages = sortSizes(recs.flatMap((r) => r.storageOptions));
      if (storages.length) entry.storages = { value: storages, provenance };
    } else if (model.tipo === 'watch') {
      const sizes = uniq(recs.map((r) => r.caseSizeMm).filter(Boolean) as string[]).sort((a, b) => Number(a) - Number(b));
      if (sizes.length) entry.caseSizesMm = { value: sizes, provenance };
      const conn = uniq(recs.map((r) => r.connectivity).filter(Boolean)) as Connectivity[];
      if (conn.length) entry.connectivity = { value: conn, provenance };
    }

    const hardware = recs.flatMap((r) => r.modelNumbers.map((modelNo) => ({
      model: modelNo,
      variant: {
        ...(r.screen && model.tipo !== 'macmini' ? { tamano: model.tipo === 'watch' ? `${r.caseSizeMm} mm` : r.screen } : {}),
        ...(r.caseSizeMm ? { tamano: `${r.caseSizeMm} mm` } : {}),
        ...(r.connectivity ? { conexion: CONNECTIVITY_VALUE[r.connectivity] } : {}),
      },
    })));
    if (hardware.length) entry.hardwareModels = { value: hardware, provenance };
    const orders = recs.flatMap((r) => r.orderCodes.map((code) => ({ code, config: r.screen && (model.tipo === 'macbook' || model.tipo === 'imac') ? { tamano: r.screen } : {} as Record<string, string> })));
    if (orders.length) entry.orderCodes = { value: orders, provenance };
    const colors = uniq(recs.flatMap((r) => r.colors));
    // Respaldo: el consolidador usa los colores de AppleDB si existen para el modelo.
    if (colors.length) entry.colors = { value: colors.map((name) => ({ name })), provenance };
    entries.push(entry);
  }
  return { entries, skipped };
}

/** Forma comparable de un hecho (las combinaciones RAM/SSD se comparan como conjuntos, sin el tamaño). */
function comparable(key: string, value: any): string {
  if (key === 'macCombos' && Array.isArray(value)) {
    const ram = sortSizes(value.flatMap((c: MacCombo) => c.ram || []));
    const ssd = sortSizes(value.flatMap((c: MacCombo) => c.almacenamiento || []));
    return JSON.stringify([ram, ssd]);
  }
  if (Array.isArray(value)) return JSON.stringify([...value].map((v) => JSON.stringify(v)).sort());
  return JSON.stringify(value);
}

/**
 * Incorpora las entradas EveryMac al dataset propio. Se conservan título/detalle canónicos y alias ya
 * definidos (compatibilidad con productos guardados) y los hechos `apple_official`; el resto se reemplaza.
 */
export function mergeEveryMacEntries(dataset: SpecsDataset, entries: DatasetModelEntry[], version?: string): SpecsDataset {
  const byId = new Map(dataset.models.map((entry) => [entry.id, { ...entry }]));
  const factKeys = ['storages', 'screens', 'caseSizesMm', 'connectivity', 'macCombos', 'colors', 'hardwareModels', 'orderCodes', 'weightKg'] as const;
  for (const incoming of entries) {
    const current = byId.get(incoming.id);
    if (!current) {
      byId.set(incoming.id, { ...incoming, listed: true });
      continue;
    }
    const merged: DatasetModelEntry = { ...current, listed: true };
    for (const key of factKeys) {
      const next = incoming[key] as any;
      const prev = current[key] as any;
      if (!next) continue;
      if (prev?.provenance?.source === 'apple_official' && key !== 'hardwareModels' && key !== 'orderCodes') {
        // Los colores leídos de EveryMac son solo respaldo: no generan conflicto frente a la ficha oficial.
        if (key !== 'colors' && comparable(key, prev.value) !== comparable(key, next.value)) {
          merged.conflicts = [...(merged.conflicts || []), { field: key, detail: `EveryMac difiere de la ficha oficial (${JSON.stringify(next.value).slice(0, 160)}); prevalece la oficial.`, sources: [prev.provenance, next.provenance] }];
        }
        continue;
      }
      (merged as any)[key] = next;
    }
    // Un conflicto previo (reglas del proyecto vs otra fuente) queda resuelto con el dato de la ficha EveryMac.
    if (merged.conflicts) {
      merged.conflicts = merged.conflicts.map((c) => {
        const fact = (incoming as any)[c.field];
        if (c.resolved || !fact || (merged as any)[c.field] !== fact) return c;
        return { ...c, resolved: true, detail: `${c.detail} Resuelto con EveryMac (${fact.provenance.url}).` };
      });
    }
    if (!current.tipo) delete merged.tipo;
    byId.set(incoming.id, merged);
  }
  return { ...dataset, version: version || dataset.version, models: [...byId.values()] };
}
