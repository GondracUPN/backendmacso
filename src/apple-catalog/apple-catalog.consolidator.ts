// Consolida AppleDB + dataset complementario + anulaciones administrativas en el catálogo que sirven
// nuestros endpoints. Función pura y determinista: el mismo input produce la misma versión.
//
// Prioridad por campo: anulación administrativa > dataset (oficial/curado/reglas previas) > AppleDB > desconocido.
// Un desacuerdo entre fuentes no se resuelve en silencio: queda en `conflicts`.
import { createHash } from 'crypto';
import type {
  AppleCatalogColor,
  AppleCatalogModel,
  AppleCatalogVariant,
  AppleDbSource,
  CatalogConflict,
  CatalogOverride,
  CatalogSelector,
  CatalogTipo,
  ConsolidatedCatalog,
  DatasetModelEntry,
  FieldStatus,
  MacCombo,
  NormalizedModel,
  Provenance,
  SelectorOption,
  SpecsDataset,
} from './apple-catalog.types';
import { normalizeAppleDb, slug } from './appledb.normalizer';
import {
  CONNECTIVITY_LABEL,
  CONNECTIVITY_VALUE,
  FAMILY_SELECTORS,
  SELECTOR_LABELS,
  buildCapabilities,
} from './device-capabilities';

export const APPLEDB_LICENSE = 'MIT (AppleDB, Copyright (c) 2022 emiyl)';

/** Etiquetas en español con ID estable (slug del nombre en inglés de AppleDB). */
export const COLOR_LABELS: Record<string, string> = {
  black: 'Negro',
  white: 'Blanco',
  silver: 'Plata',
  gold: 'Oro',
  'space-gray': 'Gris espacial',
  'space-black': 'Negro espacial',
  midnight: 'Medianoche',
  starlight: 'Blanco estrella',
  'sky-blue': 'Azul cielo',
  blue: 'Azul',
  pink: 'Rosa',
  purple: 'Morado',
  green: 'Verde',
  yellow: 'Amarillo',
  red: 'Rojo',
  '-product-red': '(PRODUCT)RED',
  'product-red': '(PRODUCT)RED',
  orange: 'Naranja',
  graphite: 'Grafito',
  'pacific-blue': 'Azul pacífico',
  'sierra-blue': 'Azul sierra',
  'alpine-green': 'Verde alpino',
  'deep-purple': 'Morado oscuro',
  'black-titanium': 'Titanio negro',
  'white-titanium': 'Titanio blanco',
  'natural-titanium': 'Titanio natural',
  'blue-titanium': 'Titanio azul',
  'desert-titanium': 'Titanio desierto',
  'titanium-black': 'Titanio negro',
  'titanium-natural': 'Titanio natural',
  'jet-black': 'Negro azabache',
  'rose-gold': 'Oro rosa',
  'cosmic-orange': 'Naranja cósmico',
  'deep-blue': 'Azul profundo',
  'mist-blue': 'Azul niebla',
  lavender: 'Lavanda',
  sage: 'Salvia',
  'light-gold': 'Oro claro',
  'cloud-white': 'Blanco nube',
  'sky-blue-': 'Azul cielo',
};

/** Etiqueta traducida; los acabados "Material - Color" conservan el material. */
const firstHex = (hex: unknown) => {
  const value = Array.isArray(hex) ? hex[0] : hex;
  return value ? `#${String(value).replace(/^#/, '')}` : null;
};

export function colorLabel(name: string): string {
  const id = slug(name);
  if (COLOR_LABELS[id]) return COLOR_LABELS[id];
  const material = name.match(/^(Titanium|Aluminum|Aluminium|Stainless Steel|Ceramic)s*-s*(.+)$/i);
  if (material) {
    const mat = /^titanium$/i.test(material[1]) ? 'Titanio' : /^ceramic$/i.test(material[1]) ? 'Cerámica' : /^stainless/i.test(material[1]) ? 'Acero inoxidable' : 'Aluminio';
    const color = COLOR_LABELS[slug(material[2])] || material[2];
    return `${mat} ${color.toLowerCase()}`;
  }
  return name;
}

const DIAGONAL_TOLERANCE = 0.05;
const storageValue = (raw: string) => {
  const text = String(raw || '').toUpperCase().replace(/\s+/g, '');
  const tb = text.match(/^(\d+)TB$/);
  if (tb) return `${tb[1]}TB`;
  const gb = text.match(/^(\d+)(?:GB)?$/);
  return gb ? gb[1] : text;
};
const storageLabel = (value: string) => (/TB$/.test(value) ? value.replace(/TB$/, ' TB') : `${value} GB`);
const uniq = <T>(items: T[]) => Array.from(new Set(items));
const numericSort = (a: string, b: string) => {
  const n = (v: string) => (/TB$/.test(v) ? parseFloat(v) * 1024 : parseFloat(v));
  return n(a) - n(b);
};
const APPLEDB: Provenance = { source: 'appledb', url: 'https://api.appledb.dev/device/main.json', license: 'MIT' };
const APPLEDB_NAME: Provenance = { source: 'appledb:name', url: 'https://api.appledb.dev/device/main.json', license: 'MIT' };

export interface LegacyProductOption {
  id: number;
  productType?: string | null;
  family?: string | null;
  value: string;
  label?: string;
  metadata?: Record<string, any> | null;
}

export interface ConsolidateInput {
  appleDb: AppleDbSource;
  appleDbHash: string;
  dataset: SpecsDataset;
  overrides?: CatalogOverride[];
  legacyOptions?: LegacyProductOption[];
  generatedAt?: string;
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const sizeOption = (tipo: CatalogTipo, value: string, diagonal?: string): SelectorOption => {
  if (tipo === 'watch') return { value: `${value} mm`, label: `${value} mm (caja)` };
  return { value, label: `${value.replace('.', ',')}″`, ...(diagonal ? { diagonal } : {}) };
};

function selector(field: CatalogSelector['field'], tipo: CatalogTipo, options: SelectorOption[], provenance: Provenance | null): CatalogSelector {
  const meta = SELECTOR_LABELS[field];
  const label = field === 'tamano' && tipo === 'watch' ? 'Tamaño de caja' : meta.label;
  const unit = field === 'tamano' && tipo === 'watch' ? 'mm' : meta.unit;
  return { field, label, unit, status: options.length ? 'confirmed' : 'unknown', options, provenance };
}

function buildColors(model: NormalizedModel, entry: DatasetModelEntry | undefined, conflicts: Array<{ field: string; detail: string }>): { colors: AppleCatalogColor[]; provenance: Provenance | null } {
  const sizes = uniq(model.variants.map((v) => v.size).filter(Boolean) as string[]);
  const fromAppleDb = new Map<string, AppleCatalogColor>();
  for (const variant of model.variants) {
    for (const color of variant.colors) {
      const id = slug(color.name);
      const existing = fromAppleDb.get(id);
      if (existing) {
        if (existing.tamano && existing.tamano !== variant.size) existing.tamano = null;
        continue;
      }
      fromAppleDb.set(id, {
        id,
        name: color.name,
        label: colorLabel(color.name),
        hex: firstHex(color.hex),
        tamano: sizes.length > 1 ? variant.size || null : null,
        provenance: APPLEDB,
      });
    }
  }
  // Un color presente en todas las variantes de tamaño no queda asociado a un tamaño concreto.
  for (const color of fromAppleDb.values()) {
    if (color.tamano && model.variants.filter((v) => v.size).every((v) => v.colors.some((c) => slug(c.name) === color.id))) color.tamano = null;
  }
  // Los acabados leídos de EveryMac son respaldo: si AppleDB trae colores del modelo, se usan esos.
  if (entry?.colors && !(entry.colors.provenance.source === 'everymac' && fromAppleDb.size)) {
    const dataset = entry.colors.value.map((color) => {
      const id = slug(color.name);
      return {
        id,
        name: color.name,
        label: color.label || colorLabel(color.name),
        hex: color.hex || fromAppleDb.get(id)?.hex || null,
        tamano: color.tamano || null,
        provenance: entry.colors!.provenance,
      };
    });
    const appleIds = [...fromAppleDb.keys()].sort().join(',');
    const datasetIds = dataset.map((c) => c.id).sort().join(',');
    if (appleIds && appleIds !== datasetIds) conflicts.push({ field: 'colors', detail: `AppleDB [${appleIds}] vs dataset [${datasetIds}]; prevalece el dataset.` });
    return { colors: dataset, provenance: entry.colors.provenance };
  }
  return { colors: [...fromAppleDb.values()], provenance: fromAppleDb.size ? APPLEDB : null };
}

function variantDetalle(tipo: CatalogTipo, connectivity: string | null | undefined, size: string | null | undefined) {
  const detalle: Record<string, string> = {};
  if ((tipo === 'ipad' || tipo === 'watch') && connectivity) detalle.conexion = CONNECTIVITY_VALUE[connectivity as keyof typeof CONNECTIVITY_VALUE];
  if (size && tipo === 'watch') detalle.tamano = `${size} mm`;
  if (size && (tipo === 'ipad' || tipo === 'macbook' || tipo === 'imac')) detalle.tamano = size;
  return detalle;
}

function consolidateModel(model: NormalizedModel, entry: DatasetModelEntry | undefined, datasetVersion: string): AppleCatalogModel {
  const tipo = model.tipo;
  const conflicts: Array<{ field: string; detail: string }> = (entry?.conflicts || []).filter((c) => !c.resolved).map((c) => ({ field: c.field, detail: c.detail }));
  const resolvedConflicts = (entry?.conflicts || []).filter((c) => c.resolved).map((c) => ({ field: c.field, detail: c.detail, resolved: true }));
  const provenance: Record<string, Provenance> = {};
  const fieldStatus: Record<string, FieldStatus> = {};

  // Variantes (Watch Ultra: AppleDB no informa tamaño ni conectividad en el nombre).
  const datasetConnectivity = entry?.connectivity?.value;
  const datasetCaseSizes = entry?.caseSizesMm?.value;
  const datasetHw = entry?.hardwareModels?.value || [];
  const variants: AppleCatalogVariant[] = model.variants.map((variant) => {
    let connectivity = variant.connectivity ?? null;
    let size = variant.size ?? null;
    if (!connectivity && datasetConnectivity?.length === 1) connectivity = datasetConnectivity[0];
    if (!size && tipo === 'watch' && datasetCaseSizes?.length === 1) size = datasetCaseSizes[0];
    if (!size && (tipo === 'macbook' || tipo === 'imac')) {
      const hw = datasetHw.find((item) => variant.hardwareModels.includes(item.model) && item.variant?.tamano);
      if (hw) size = hw.variant!.tamano;
      else if (entry?.screens?.value.length === 1) size = entry.screens.value[0].value;
    }
    const labelParts = [
      connectivity ? CONNECTIVITY_LABEL[connectivity] : null,
      size ? (tipo === 'watch' ? `${size} mm` : `${size}″`) : null,
    ].filter(Boolean);
    return {
      id: variant.id === 'default' && size ? size : variant.id,
      label: labelParts.join(' · ') || model.title,
      connectivity,
      size,
      detalle: variantDetalle(tipo, connectivity, size),
      hardwareModels: variant.hardwareModels,
      identifiers: variant.identifiers,
      appleDbKeys: variant.appleDbKeys,
      capabilities: buildCapabilities(tipo, connectivity, entry?.imeiCount?.value ?? null, entry?.battery?.value),
    };
  });

  // Selectores comerciales según la matriz de la familia.
  const selectors: CatalogSelector[] = [];
  let macCombos: MacCombo[] | null = null;
  for (const field of FAMILY_SELECTORS[tipo]) {
    let options: SelectorOption[] = [];
    let prov: Provenance | null = null;
    if (field === 'tamano') {
      if (tipo === 'watch') {
        const sizes = datasetCaseSizes || uniq(variants.map((v) => v.size).filter(Boolean) as string[]);
        options = sizes.sort((a, b) => Number(a) - Number(b)).map((size) => sizeOption(tipo, size));
        prov = entry?.caseSizesMm?.provenance || (options.length ? APPLEDB_NAME : null);
      } else if (entry?.screens) {
        options = entry.screens.value.map((screen) => sizeOption(tipo, screen.value, screen.diagonal));
        prov = entry.screens.provenance;
        const named = uniq(variants.map((v) => v.size).filter(Boolean) as string[]);
        const datasetValues = entry.screens.value.map((s) => s.value);
        if (named.length && named.some((value) => !datasetValues.includes(value))) {
          conflicts.push({ field: 'tamano', detail: `Pantalla: AppleDB indica [${named.join(', ')}] y el dataset [${datasetValues.join(', ')}].` });
        }
      } else {
        const named = uniq(variants.map((v) => v.size).filter(Boolean) as string[]).sort((a, b) => Number(a) - Number(b));
        options = named.map((size) => sizeOption(tipo, size));
        prov = options.length ? APPLEDB_NAME : null;
      }
      if (model.displayDiagonal) {
        const diag = Number(model.displayDiagonal);
        if (Number.isFinite(diag) && options.length === 1 && !options[0].diagonal && Math.abs(Number(options[0].value) - diag) > DIAGONAL_TOLERANCE) {
          options[0] = { ...options[0], diagonal: String(diag) };
        }
      }
    } else if (field === 'conexion') {
      const order = ['wifi', 'cellular', 'gps', 'gps_cellular'];
      const values = uniq(variants.map((v) => v.connectivity).filter(Boolean) as string[]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
      options = values.map((value) => ({ value: CONNECTIVITY_VALUE[value as keyof typeof CONNECTIVITY_VALUE], label: CONNECTIVITY_LABEL[value as keyof typeof CONNECTIVITY_LABEL] }));
      prov = entry?.connectivity?.provenance || (options.length ? APPLEDB_NAME : null);
    } else if (field === 'almacenamiento' && (tipo === 'iphone' || tipo === 'ipad')) {
      const appleStorage = (model.memory?.storage || []).map(storageValue);
      if (entry?.storages) {
        options = entry.storages.value.map((value) => ({ value, label: storageLabel(value) }));
        prov = entry.storages.provenance;
        if (appleStorage.length && appleStorage.slice().sort().join(',') !== entry.storages.value.slice().sort().join(',')) {
          conflicts.push({ field: 'almacenamiento', detail: `AppleDB [${appleStorage.join(', ')}] vs dataset [${entry.storages.value.join(', ')}]; prevalece el dataset.` });
        }
      } else if (appleStorage.length) {
        options = appleStorage.sort(numericSort).map((value) => ({ value, label: storageLabel(value) }));
        prov = APPLEDB;
      }
    } else if (field === 'ram' || field === 'almacenamiento') {
      if (!macCombos) {
        if (entry?.macCombos) {
          macCombos = entry.macCombos.value;
          provenance.macCombos = entry.macCombos.provenance;
        } else if (model.memory?.ram.length && model.memory.storage.length) {
          macCombos = [{ ram: model.memory.ram.map((v) => storageValue(v)), almacenamiento: model.memory.storage.map(storageValue) }];
          provenance.macCombos = APPLEDB;
        }
      }
      const values = uniq((macCombos || []).flatMap((combo) => (field === 'ram' ? combo.ram : combo.almacenamiento))).sort(numericSort);
      options = values.map((value) => ({ value, label: field === 'ram' ? `${value} GB` : storageLabel(value) }));
      prov = provenance.macCombos || null;
    }
    const sel = selector(field, tipo, options, prov);
    selectors.push(sel);
    fieldStatus[field] = sel.status;
    if (prov) provenance[field] = prov;
  }

  const { colors, provenance: colorProv } = buildColors(model, entry, conflicts);
  if (colorProv) provenance.colors = colorProv;
  fieldStatus.colors = colors.length ? 'confirmed' : 'unknown';

  const modelCaps = buildCapabilities(
    tipo,
    variants.length === 1 ? variants[0].connectivity : null,
    entry?.imeiCount?.value ?? null,
    entry?.battery?.value,
  );
  if (entry?.battery) provenance.battery = entry.battery.provenance;
  if (entry?.imeiCount) provenance.imeiCount = entry.imeiCount.provenance;
  fieldStatus.imei = modelCaps.identifiers.imeiStatus === 'confirmed' || variants.every((v) => v.capabilities.identifiers.imeiStatus === 'confirmed') ? 'confirmed' : 'unknown';

  const hardwareModels = variants.flatMap((variant) => variant.hardwareModels.map((hw) => ({ model: hw, variantId: variant.id })));
  const detalle = entry?.detalle || model.detalle;
  const detalleAliases = [
    ...(entry?.detalleAliases || []),
    ...(entry?.detalle && JSON.stringify(entry.detalle) !== JSON.stringify(model.detalle) ? [model.detalle] : []),
  ];

  let airpods: AppleCatalogModel['airpods'] = null;
  if (tipo === 'airpods') {
    airpods = {
      generation: model.generation || model.title,
      anc: entry?.anc ? entry.anc.value : null,
      ancSelectable: false,
      caseLabel: entry?.caseConnector?.value || null,
    };
    fieldStatus.anc = entry?.anc ? 'confirmed' : 'unknown';
    if (entry?.anc) provenance.anc = entry.anc.provenance;
  }

  const needsReview = [...model.needsReview];
  if (entry?.detalle) {
    const idx = needsReview.indexOf('detalle.numero');
    if (idx >= 0) needsReview.splice(idx, 1);
  }

  return {
    id: model.id,
    tipo,
    title: entry?.title || model.title,
    detalle,
    detalleAliases,
    aliases: uniq([...(entry?.aliases || [])]),
    chip: model.chip || null,
    released: model.released || null,
    discontinued: model.discontinued || null,
    selectors,
    macCombos,
    variants,
    colors,
    colorStatus: colors.length ? 'confirmed' : 'unknown',
    capabilities: modelCaps,
    airpods,
    hardwareModels,
    identifiers: uniq(variants.flatMap((v) => v.identifiers)),
    orderCodes: entry?.orderCodes?.value,
    weightKg: entry?.weightKg?.value || null,
    fieldStatus,
    provenance,
    sources: { appleDbKeys: variants.flatMap((v) => v.appleDbKeys), appleDbGroups: model.appleDbGroups, datasetVersion: entry ? datasetVersion : null },
    conflicts: [...conflicts, ...resolvedConflicts],
    needsReview,
    listed: Boolean(entry?.listed),
  };
}

/** Aplica una anulación administrativa verificada y bloqueada (prevalece sobre todas las fuentes). */
export function applyOverride(model: AppleCatalogModel, override: CatalogOverride): void {
  const prov: Provenance = { source: 'override', note: override.reason, verifiedAt: override.createdAt };
  const value = override.value;
  if (override.field === 'title' && typeof value === 'string') model.title = value;
  else if (override.field === 'detalle' && value && typeof value === 'object') model.detalle = { ...value };
  else if (override.field === 'retired') model.retired = Boolean(value);
  else if (override.field === 'listed') model.listed = Boolean(value);
  else if (override.field === 'anc' && model.airpods) {
    model.airpods.anc = value === null ? null : Boolean(value);
    model.fieldStatus.anc = value === null ? 'unknown' : 'confirmed';
  } else if (override.field === 'colors' && Array.isArray(value)) {
    model.colors = value.map((color: any) => {
      const name = String(color?.name || color);
      const id = slug(name);
      return { id, name, label: String(color?.label || COLOR_LABELS[id] || name), hex: color?.hex || null, tamano: color?.tamano || null, provenance: prov };
    });
    model.colorStatus = model.colors.length ? 'confirmed' : 'unknown';
    model.fieldStatus.colors = model.colorStatus;
  } else if (override.field === 'macCombos' && Array.isArray(value)) {
    model.macCombos = value;
    for (const field of ['ram', 'almacenamiento'] as const) {
      const sel = model.selectors.find((s) => s.field === field);
      if (!sel) continue;
      const values = uniq(value.flatMap((combo: MacCombo) => combo[field] || [])).sort(numericSort);
      sel.options = values.map((v) => ({ value: v, label: field === 'ram' ? `${v} GB` : storageLabel(v) }));
      sel.status = values.length ? 'confirmed' : 'unknown';
      sel.provenance = prov;
      model.fieldStatus[field] = sel.status;
    }
  } else if (override.field.startsWith('selectors.') && Array.isArray(value)) {
    const field = override.field.slice('selectors.'.length);
    const sel = model.selectors.find((s) => s.field === field);
    if (sel) {
      sel.options = value.map((v: any) => (typeof v === 'object' ? { value: String(v.value), label: String(v.label || v.value), ...(v.diagonal ? { diagonal: String(v.diagonal) } : {}) } : { value: String(v), label: field === 'almacenamiento' ? storageLabel(String(v)) : String(v) }));
      sel.status = sel.options.length ? 'confirmed' : 'unknown';
      sel.provenance = prov;
      model.fieldStatus[field] = sel.status;
    }
  } else if (override.field === 'imeiCount' && [0, 1, 2].includes(Number(value))) {
    model.capabilities.identifiers = { ...model.capabilities.identifiers, imeiCount: Number(value) as 0 | 1 | 2, imeiStatus: 'confirmed' };
    if (model.tipo === 'iphone') model.variants.forEach((v) => (v.capabilities.identifiers = { ...model.capabilities.identifiers }));
  } else if (override.field === 'battery' && value && typeof value === 'object') {
    model.capabilities.battery = { ...model.capabilities.battery, ...value };
    model.variants.forEach((v) => (v.capabilities.battery = { ...model.capabilities.battery }));
  } else {
    model.conflicts.push({ field: override.field, detail: `Anulación ${override.id ?? ''} no aplicable (${override.field}).` });
    return;
  }
  model.provenance[override.field] = prov;
}

/** Opciones creadas antes desde /catalog/product-options: se conservan como opciones con procedencia propia. */
function applyLegacyOptions(models: AppleCatalogModel[], legacy: LegacyProductOption[], datasetVersion: string): AppleCatalogModel[] {
  const extra: AppleCatalogModel[] = [];
  const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const prov: Provenance = { source: 'legacy_admin_option', note: 'Opción creada desde Catálogo (product-options).' };
  for (const option of legacy) {
    const type = lower(option.productType) as CatalogTipo;
    const meta = option.metadata || {};
    const list = (key: string) => (Array.isArray(meta[key]) ? meta[key].map((v: any) => String(v).trim()).filter(Boolean) : []);
    const candidates = models.filter((model) => {
      if (model.tipo !== type) return false;
      const d = model.detalle;
      if (type === 'macbook') return lower(d.gama) === lower(option.family) && lower(d.procesador) === lower(option.value);
      if (type === 'ipad') return lower(d.gama) === lower(option.family) && (lower(d.procesador) === lower(option.value) || lower(d.generacion) === lower(option.value));
      if (type === 'iphone') return lower(d.numero) === lower(option.family);
      return false;
    });
    const addOptions = (model: AppleCatalogModel) => {
      const add = (field: CatalogSelector['field'], values: string[]) => {
        const sel = model.selectors.find((s) => s.field === field);
        if (!sel || !values.length) return;
        for (const value of values) {
          const normalized = field === 'almacenamiento' || field === 'ram' ? storageValue(value) : value;
          if (!sel.options.some((o) => o.value === normalized)) {
            sel.options.push({ value: normalized, label: field === 'almacenamiento' ? storageLabel(normalized) : field === 'ram' ? `${normalized} GB` : normalized });
            model.conflicts.push({ field, detail: `Opción ${normalized} añadida por catálogo administrativo previo (#${option.id}); revisar.` });
          }
        }
        if (sel.options.length) sel.status = 'confirmed';
        sel.provenance = sel.provenance || prov;
        if (model.macCombos && (field === 'ram' || field === 'almacenamiento')) {
          model.macCombos = [...model.macCombos, { ram: field === 'ram' ? values : model.macCombos[0].ram, almacenamiento: field === 'almacenamiento' ? values.map(storageValue) : model.macCombos[0].almacenamiento }];
        }
      };
      add('tamano', list('sizes'));
      add('ram', list('rams'));
      add('almacenamiento', list('storages'));
    };
    if (type === 'iphone') {
      const models2 = list('models');
      for (const modelo of models2.length ? models2 : ['Normal']) {
        const found = candidates.find((m) => lower(m.detalle.modelo) === lower(modelo));
        if (found) addOptions(found);
        else extra.push(legacyModel(type, `legacy-${option.id}-${slug(modelo)}`, `iPhone ${option.family} ${modelo}`, { numero: String(option.family), modelo }, list('storages'), prov, datasetVersion));
      }
      continue;
    }
    if (candidates.length) candidates.forEach(addOptions);
    else if (type === 'macbook' || type === 'ipad') {
      const detalle = type === 'macbook' ? { gama: String(option.family), procesador: option.value } : { gama: String(option.family), [/^\d+$/.test(option.value) ? 'generacion' : 'procesador']: option.value };
      const model = legacyModel(type, `legacy-${option.id}`, option.label || `${option.family} ${option.value}`, detalle, list('storages'), prov, datasetVersion);
      if (type === 'macbook' && (list('rams').length || list('storages').length)) {
        model.macCombos = [{ ram: list('rams').map(storageValue), almacenamiento: list('storages').map(storageValue) }];
      }
      const sizes = list('sizes');
      const sizeSel = model.selectors.find((s) => s.field === 'tamano');
      if (sizeSel) { sizeSel.options = sizes.map((s) => sizeOption(type, s)); sizeSel.status = sizes.length ? 'confirmed' : 'unknown'; }
      const ramSel = model.selectors.find((s) => s.field === 'ram');
      if (ramSel) { ramSel.options = list('rams').map((v) => ({ value: storageValue(v), label: `${storageValue(v)} GB` })); ramSel.status = ramSel.options.length ? 'confirmed' : 'unknown'; }
      extra.push(model);
    }
  }
  return extra;
}

function legacyModel(tipo: CatalogTipo, id: string, title: string, detalle: Record<string, string>, storages: string[], prov: Provenance, datasetVersion: string): AppleCatalogModel {
  const selectors = FAMILY_SELECTORS[tipo].map((field) => {
    const options = field === 'almacenamiento' ? storages.map(storageValue).map((v) => ({ value: v, label: storageLabel(v) }))
      : field === 'conexion' && tipo === 'ipad' ? [{ value: 'Wifi', label: 'Wi-Fi' }, { value: 'Wifi + Cel', label: 'Wi-Fi + Cellular' }] : [];
    return selector(field, tipo, options, options.length ? prov : null);
  });
  return {
    id,
    tipo,
    title,
    detalle,
    detalleAliases: [],
    aliases: [],
    selectors,
    macCombos: null,
    variants: [],
    colors: [],
    colorStatus: 'unknown',
    capabilities: buildCapabilities(tipo, null),
    airpods: null,
    hardwareModels: [],
    identifiers: [],
    fieldStatus: Object.fromEntries(selectors.map((s) => [s.field, s.status])),
    provenance: { detalle: prov },
    sources: { appleDbKeys: [], appleDbGroups: [], datasetVersion },
    conflicts: [{ field: 'source', detail: 'Modelo creado desde una opción administrativa previa; no está en AppleDB ni en el dataset.' }],
    needsReview: ['legacy_admin_option'],
    listed: true,
  };
}

/**
 * Modelo manual del dataset (lanzamiento que AppleDB aún no publica): mismo proceso de consolidación,
 * marcado para revisión. Requiere tipo, título y detalle canónico.
 */
function manualNormalizedModel(entry: DatasetModelEntry): NormalizedModel {
  const tipo = entry.tipo as CatalogTipo;
  const connectivity = entry.connectivity?.value?.length ? entry.connectivity.value : [null];
  const sizes = tipo === 'watch' && entry.caseSizesMm?.value?.length ? entry.caseSizesMm.value : [null];
  const variants = connectivity.flatMap((conn) => sizes.map((size) => ({
    id: [conn || 'default', size].filter(Boolean).join('-'),
    name: entry.title || entry.id,
    appleDbKeys: [],
    hardwareModels: (entry.hardwareModels?.value || []).filter((hw) => !hw.variant?.conexion || hw.variant.conexion === conn).map((hw) => hw.model),
    identifiers: [],
    connectivity: conn,
    size,
    colors: [],
  })));
  return {
    id: entry.id,
    tipo,
    appleDbType: 'manual',
    title: entry.title || entry.id,
    detalle: entry.detalle || {},
    chip: entry.detalle?.procesador || null,
    released: null,
    discontinued: null,
    appleDbGroups: [],
    variants,
    memory: null,
    displayDiagonal: null,
    components: tipo === 'airpods' ? [] : undefined,
    generation: tipo === 'airpods' ? String(entry.title || '').replace(/\s+(con ANC|sin ANC|con estuche inalámbrico|USB-C)$/i, '').trim() : undefined,
    needsReview: ['manual_dataset_model'],
  };
}

export function consolidateCatalog(input: ConsolidateInput): ConsolidatedCatalog {
  const { models: appleDbModels, report } = normalizeAppleDb(input.appleDb);
  const appleIds = new Set(appleDbModels.map((m) => m.id));
  const manual = input.dataset.models
    .filter((entry) => !appleIds.has(entry.id) && entry.tipo && entry.title && entry.detalle && Object.keys(entry.detalle).length)
    .map(manualNormalizedModel);
  const normalized = [...appleDbModels, ...manual];
  const datasetById = new Map(input.dataset.models.map((entry) => [entry.id, entry]));
  const retained = new Set(input.appleDb.retainedKeys || []);
  const models = normalized.map((model) => {
    const consolidated = consolidateModel(model, datasetById.get(model.id), input.dataset.version);
    if (consolidated.sources.appleDbKeys.length && consolidated.sources.appleDbKeys.every((key) => retained.has(key))) consolidated.retired = true;
    return consolidated;
  });

  // AirPods: ANC seleccionable solo si la misma generación tiene ediciones documentadas con y sin ANC.
  const byGeneration = new Map<string, AppleCatalogModel[]>();
  for (const model of models.filter((m) => m.airpods)) {
    byGeneration.set(model.airpods!.generation, [...(byGeneration.get(model.airpods!.generation) || []), model]);
  }
  for (const group of byGeneration.values()) {
    const ancValues = new Set(group.map((m) => m.airpods!.anc));
    const selectable = ancValues.has(true) && ancValues.has(false);
    group.forEach((m) => (m.airpods!.ancSelectable = selectable));
  }

  const legacyModels = applyLegacyOptions(models, input.legacyOptions || [], input.dataset.version);
  const all = [...models, ...legacyModels];
  const byId = new Map(all.map((m) => [m.id, m]));
  const overrides = [...(input.overrides || [])].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || (a.id || 0) - (b.id || 0));
  const orphanOverrides: CatalogConflict[] = [];
  for (const override of overrides) {
    const model = byId.get(override.modelId);
    if (model) applyOverride(model, override);
    // Una anulación sin modelo (p. ej. tras renombrarse en AppleDB) no se ignora en silencio.
    else orphanOverrides.push({ modelId: override.modelId, field: 'override', detail: `Anulación #${override.id ?? ''} (${override.field}) sin modelo correspondiente; revisar o desactivar.` });
  }

  const knownIds = new Set(models.map((m) => m.id));
  const conflicts: CatalogConflict[] = [
    ...orphanOverrides,
    ...all.flatMap((model) => model.conflicts.map((c) => ({ modelId: model.id, field: c.field, detail: c.detail, ...(c.resolved ? { resolved: true } : {}) }))),
    ...input.dataset.models
      .filter((entry) => !knownIds.has(entry.id))
      .map((entry) => ({ modelId: entry.id, field: 'dataset', detail: 'Entrada del dataset sin modelo en AppleDB; para publicarla como modelo manual indica tipo, title y detalle.' })),
  ];

  const version = hashJson({
    a: input.appleDbHash,
    d: input.dataset.version,
    dh: hashJson(input.dataset.models),
    o: overrides.map((o) => [o.modelId, o.field, o.value]),
    l: (input.legacyOptions || []).map((o) => [o.id, o.metadata]),
  }).slice(0, 16);

  return {
    version,
    generatedAt: input.generatedAt || new Date().toISOString(),
    appleDb: { fetchedAt: input.appleDb.fetchedAt, hash: input.appleDbHash, sourceUrl: input.appleDb.sourceUrl, license: APPLEDB_LICENSE, retainedKeys: [...retained] },
    dataset: { version: input.dataset.version, publishedAt: input.dataset.publishedAt },
    overridesCount: overrides.length,
    models: all,
    conflicts,
    report,
  };
}

// ---------------- Cobertura por familia ----------------
export interface CoverageRow {
  tipo: CatalogTipo;
  models: number;
  fields: Record<string, { confirmed: number; unknown: number; official: number; everymac: number; curated: number; appledb: number }>;
  gaps: Array<{ modelId: string; field: string }>;
}

const COMMERCIAL_FIELDS: Record<CatalogTipo, string[]> = {
  iphone: ['almacenamiento', 'colors', 'imei'],
  ipad: ['tamano', 'almacenamiento', 'conexion', 'colors', 'imei'],
  watch: ['tamano', 'conexion', 'colors', 'imei'],
  macbook: ['tamano', 'ram', 'almacenamiento', 'colors'],
  imac: ['tamano', 'ram', 'almacenamiento', 'colors'],
  macmini: ['ram', 'almacenamiento', 'colors'],
  airpods: ['anc', 'colors'],
};

/** Cobertura del alcance comercial (modelos listados); con `listedOnly: false` incluye todo lo descubierto. */
export function coverageReport(catalog: ConsolidatedCatalog, options: { listedOnly?: boolean } = {}): CoverageRow[] {
  const listedOnly = options.listedOnly !== false;
  const rows: CoverageRow[] = [];
  for (const tipo of Object.keys(COMMERCIAL_FIELDS) as CatalogTipo[]) {
    const models = catalog.models.filter((m) => m.tipo === tipo && !m.retired && (!listedOnly || m.listed));
    const fields: CoverageRow['fields'] = {};
    const gaps: CoverageRow['gaps'] = [];
    for (const field of COMMERCIAL_FIELDS[tipo]) {
      const stats = { confirmed: 0, unknown: 0, official: 0, everymac: 0, curated: 0, appledb: 0 };
      for (const model of models) {
        const status = model.fieldStatus[field] || 'unknown';
        if (status === 'confirmed') stats.confirmed++;
        else { stats.unknown++; gaps.push({ modelId: model.id, field }); }
        const src = model.provenance[field === 'ram' || (field === 'almacenamiento' && tipo !== 'iphone' && tipo !== 'ipad') ? 'macCombos' : field === 'imei' ? (tipo === 'ipad' || tipo === 'watch' ? 'conexion' : 'imeiCount') : field]?.source;
        if (status !== 'confirmed') continue;
        if (src === 'apple_official' || src === 'override') stats.official++;
        else if (src === 'everymac') stats.everymac++;
        else if (src === 'appledb' || src === 'appledb:name') stats.appledb++;
        else stats.curated++;
      }
      fields[field] = stats;
    }
    rows.push({ tipo, models: models.length, fields, gaps });
  }
  return rows;
}
