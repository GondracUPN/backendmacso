// Resolución de modelos: (1) desde los campos `detalle` guardados en un producto y
// (2) desde identificadores en texto (Axxxx, códigos de pedido, identificadores de sistema).
// Devuelve exacto/ambiguo/desconocido con candidatos; nunca inventa configuraciones.
import type { AppleCatalogModel, AppleCatalogVariant, CatalogTipo, ConsolidatedCatalog } from './apple-catalog.types';
import { FAMILY_HIDDEN_FIELDS, connectivityFromValue } from './device-capabilities';

const norm = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const compact = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export type ResolutionStatus = 'exact' | 'ambiguous' | 'unknown';

export interface ModelResolution {
  status: ResolutionStatus;
  model: AppleCatalogModel | null;
  variant: AppleCatalogVariant | null;
  candidates: Array<{ id: string; title: string }>;
  /** Valores guardados que no pertenecen a las opciones válidas del modelo (legado pendiente de revisión). */
  invalid: Array<{ field: string; value: string; reason: string }>;
}

function templateMatches(template: Record<string, string>, detalle: Record<string, any>) {
  const keys = Object.keys(template);
  return keys.length > 0 && keys.every((key) => norm(template[key]) === norm(detalle?.[key]));
}

const airpodsKey = (value: unknown) => norm(value).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

/** Formatos legados equivalentes (Watch: gama 'Normal' = Series; generacion 'Ultra 2' = gama Ultra + 2). */
export function normalizeLegacyDetalle(tipo: string, detalle: Record<string, any>): Record<string, any> {
  const out = { ...(detalle || {}) };
  if (norm(tipo) === 'watch') {
    const gama = String(out.gama ?? '').trim();
    const gen = String(out.generacion ?? '').trim();
    const split = gen.match(/^(Series|SE|Ultra)\s*(\d*)$/i);
    if (split) {
      out.gama = split[1].replace(/^series$/i, 'Series').replace(/^se$/i, 'SE').replace(/^ultra$/i, 'Ultra');
      out.generacion = split[2] || '1';
    } else if (/^normal$/i.test(gama) || (!gama && /^\d+$/.test(gen))) out.gama = 'Series';
  }
  return out;
}

export function matchModels(catalog: ConsolidatedCatalog, tipo: string, rawDetalle: Record<string, any>): AppleCatalogModel[] {
  const type = norm(tipo) as CatalogTipo;
  const detalle = normalizeLegacyDetalle(tipo, rawDetalle);
  const pool = catalog.models.filter((model) => model.tipo === type);
  if (type === 'airpods') {
    const value = airpodsKey(detalle?.modelo || detalle?.descripcionOtro);
    if (!value) return [];
    return pool.filter((model) => [model.title, model.detalle.modelo, ...model.aliases].some((alias) => airpodsKey(alias) === value));
  }
  const matches = pool.filter((model) => [model.detalle, ...model.detalleAliases].some((template) => templateMatches(template, detalle || {})));
  // Varias coincidencias por plantilla parcial: preferir la más específica.
  if (matches.length > 1) {
    const size = (m: AppleCatalogModel) => Math.max(...[m.detalle, ...m.detalleAliases].filter((t) => templateMatches(t, detalle)).map((t) => Object.keys(t).length));
    const best = Math.max(...matches.map(size));
    return matches.filter((m) => size(m) === best);
  }
  return matches;
}

export function resolveVariant(model: AppleCatalogModel, detalle: Record<string, any>): AppleCatalogVariant | null {
  if (model.variants.length === 1) return model.variants[0];
  const connectivity = connectivityFromValue(detalle?.conexion);
  const size = String(detalle?.tamano ?? '').replace(/\s*mm$/i, '').trim();
  const found = model.variants.filter((variant) => {
    if (variant.connectivity && connectivity && variant.connectivity !== connectivity) return false;
    if (variant.connectivity && !connectivity) return false;
    if (variant.size && size && variant.size !== size) return false;
    if (variant.size && !size && model.variants.some((v) => v.size && v.size !== variant.size)) return false;
    return true;
  });
  return found.length === 1 ? found[0] : null;
}

/** Comprueba los valores de selectores guardados frente a las opciones válidas del modelo. */
export function invalidSelections(model: AppleCatalogModel, detalle: Record<string, any>) {
  const invalid: ModelResolution['invalid'] = [];
  for (const selector of model.selectors) {
    const value = String(detalle?.[selector.field] ?? '').trim();
    if (!value || selector.status !== 'confirmed') continue;
    const ok = selector.options.some((option) => norm(option.value) === norm(value) || compact(option.value) === compact(value));
    if (!ok) invalid.push({ field: selector.field, value, reason: `No es una opción válida (${selector.options.map((o) => o.value).join(', ')}).` });
  }
  if (model.macCombos?.length) {
    const ram = String(detalle?.ram ?? '').trim();
    const ssd = String(detalle?.almacenamiento ?? '').trim();
    const size = String(detalle?.tamano ?? '').trim();
    if (ram && ssd) {
      const valid = model.macCombos.some((combo) =>
        combo.ram.includes(ram) && combo.almacenamiento.includes(ssd) && (!combo.tamano?.length || !size || combo.tamano.includes(size)));
      if (!valid && !invalid.some((i) => i.field === 'ram' || i.field === 'almacenamiento')) {
        invalid.push({ field: 'ram', value: `${ram}/${ssd}`, reason: 'Combinación RAM/almacenamiento no vendida para este chip.' });
      }
    }
  }
  for (const field of FAMILY_HIDDEN_FIELDS[model.tipo] || []) {
    const value = String(detalle?.[field] ?? '').trim();
    if (value) invalid.push({ field, value, reason: 'Campo no aplicable a esta familia.' });
  }
  return invalid;
}

export function resolveProductModel(catalog: ConsolidatedCatalog, tipo: string, detalle: Record<string, any>): ModelResolution {
  const matches = matchModels(catalog, tipo, detalle || {});
  if (!matches.length) return { status: 'unknown', model: null, variant: null, candidates: [], invalid: [] };
  if (matches.length > 1) {
    return { status: 'ambiguous', model: null, variant: null, candidates: matches.map((m) => ({ id: m.id, title: m.title })), invalid: [] };
  }
  const model = matches[0];
  return {
    status: 'exact',
    model,
    variant: resolveVariant(model, detalle || {}),
    candidates: [{ id: model.id, title: model.title }],
    invalid: invalidSelections(model, detalle || {}),
  };
}

// ---------------- Identificación por texto ----------------
export interface IdentifyCandidate {
  modelId: string;
  title: string;
  tipo: CatalogTipo;
  variantId: string | null;
  matchedBy: 'hardware_model' | 'order_code' | 'identifier';
  token: string;
  /** Valores que el identificador determina (no mínimos de familia). */
  detalle: Record<string, string>;
  conflicts: string[];
  weightKg?: number | null;
}
export interface IdentifyResult {
  status: ResolutionStatus;
  tokens: string[];
  candidates: IdentifyCandidate[];
}

export function identifyFromText(catalog: ConsolidatedCatalog, text: string): IdentifyResult {
  const source = String(text || '');
  const compactSource = compact(source);
  const tokens: string[] = [];
  const candidates: IdentifyCandidate[] = [];
  const push = (candidate: IdentifyCandidate) => {
    if (!candidates.some((c) => c.modelId === candidate.modelId && c.variantId === candidate.variantId)) candidates.push(candidate);
  };
  const weightFor = (model: AppleCatalogModel, size?: string | null) =>
    model.weightKg ? (size && model.weightKg[size]) || model.weightKg.default || (Object.keys(model.weightKg).length === 1 ? Object.values(model.weightKg)[0] : null) : null;

  // 1) Códigos de pedido (MHFC4LL/A → MHFC4). Solo su configuración documentada.
  for (const model of catalog.models) {
    for (const order of model.orderCodes || []) {
      const code = compact(order.code);
      if (!code || !compactSource.includes(code)) continue;
      tokens.push(order.code);
      const conflicts = model.conflicts.filter((c) => c.field === 'hardwareModels' && !c.resolved).map((c) => c.detail);
      push({
        modelId: model.id, title: model.title, tipo: model.tipo, variantId: order.config.tamano || null,
        matchedBy: 'order_code', token: order.code, detalle: { ...model.detalle, ...order.config }, conflicts,
        weightKg: weightFor(model, order.config.tamano),
      });
    }
  }
  // 2) Números de modelo Axxxx (pueden repetirse entre generaciones: A2338 = Pro M1 y Pro M2).
  const aNumbers = Array.from(new Set((source.toUpperCase().match(/\bA\d{4}\b/g) || [])));
  for (const token of aNumbers) {
    tokens.push(token);
    for (const model of catalog.models) {
      const hits = model.hardwareModels.filter((hw) => hw.model.toUpperCase() === token);
      if (!hits.length) continue;
      const variantIds = Array.from(new Set(hits.map((h) => h.variantId || null)));
      const sizeConflict = model.conflicts.filter((c) => c.field === 'hardwareModels' && !c.resolved).map((c) => c.detail);
      // Si el número A del tamaño está en conflicto entre fuentes, no se fija la variante.
      const variant = variantIds.length === 1 && !sizeConflict.length ? model.variants.find((v) => v.id === variantIds[0]) || null : null;
      push({
        modelId: model.id, title: model.title, tipo: model.tipo, variantId: variant?.id || null,
        matchedBy: 'hardware_model', token, detalle: { ...model.detalle, ...(variant?.detalle || {}) }, conflicts: sizeConflict,
        weightKg: weightFor(model, variant?.size),
      });
    }
  }
  // 3) Identificadores de sistema (Mac14,2, iPhone17,1, Watch7,12).
  const ids = Array.from(new Set(source.match(/\b(?:iPhone|iPad|Watch|Mac|MacBookAir|MacBookPro|Macmini|iMac|AirPods(?:Pro|Max)?)\d+,\d+\b/g) || []));
  for (const token of ids) {
    tokens.push(token);
    for (const model of catalog.models) {
      const variant = model.variants.find((v) => v.identifiers.includes(token));
      if (!variant) continue;
      push({
        modelId: model.id, title: model.title, tipo: model.tipo, variantId: variant.id,
        matchedBy: 'identifier', token, detalle: { ...model.detalle, ...variant.detalle }, conflicts: [],
        weightKg: weightFor(model, variant.size),
      });
    }
  }
  const models = new Set(candidates.map((c) => c.modelId));
  return {
    status: models.size === 0 ? 'unknown' : models.size === 1 ? 'exact' : 'ambiguous',
    tokens: Array.from(new Set(tokens)),
    candidates,
  };
}
