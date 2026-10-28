// Catálogo Apple consolidado servido desde nuestra API.
// Persistencia sin cambios de esquema: filas JSONB de `app_catalog_items` con `kind` propio.
//   apple_catalog_state     → value 'appledb': etag, última ejecución/éxito/error, instantánea activa.
//   apple_catalog_snapshot  → value = sha256 del subconjunto AppleDB validado (se conservan las últimas).
//   apple_specs_dataset     → value = versión del dataset complementario importado (JSON).
//   apple_catalog_override  → value = modelId: anulación administrativa justificada.
// Los formularios leen de memoria (caché por versión); nunca se consulta AppleDB por petición de lectura.
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { CatalogItem } from '../catalog/catalog-item.entity';
import {
  coverageReport,
  consolidateCatalog,
  hashJson,
  type LegacyProductOption,
} from './apple-catalog.consolidator';
import {
  identifyFromText,
  invalidSelections,
  resolveProductModel,
  type ModelResolution,
} from './apple-catalog.resolver';
import type {
  AppleDbSource,
  CatalogOverride,
  CatalogTipo,
  ConsolidatedCatalog,
  SpecsDataset,
} from './apple-catalog.types';
import { CATALOG_TIPOS } from './apple-catalog.types';
import { APPLEDB_SOURCE_TYPES, minimizeAppleDbSource, normalizeAppleDb } from './appledb.normalizer';
import { EVERYMAC_SEED } from './data/everymac-seed.data';
import { mapRecordToModel, mergeEveryMacEntries, recordsToDatasetEntries } from './everymac.mapper';
import type { EveryMacRecord } from './everymac.parser';
import { EVERYMAC_MAX_URLS, EveryMacProvider, normalizeEveryMacUrl } from './everymac.provider';
import { APPLEDB_DEVICE_URL, AppleDbProvider } from './appledb.provider';
import { APPLEDB_BASELINE } from './data/appledb-baseline.data';
import { APPLE_SPECS_DATASET } from './data/apple-specs.dataset';
import {
  FAMILY_HIDDEN_FIELDS,
  FAMILY_SELECTORS,
  connectivityFromValue,
  inventoryCompleteness,
  inventoryFieldRules,
  type InventoryFieldRules,
} from './device-capabilities';

export const KIND_STATE = 'apple_catalog_state';
export const KIND_SNAPSHOT = 'apple_catalog_snapshot';
export const KIND_DATASET = 'apple_specs_dataset';
export const KIND_OVERRIDE = 'apple_catalog_override';
export const KIND_EVERYMAC = 'apple_everymac_page';

/**
 * Dataset efectivo: dataset propio + fichas EveryMac (semilla empaquetada + importadas en BD, por URL;
 * la importación más reciente de una URL reemplaza a la anterior).
 */
export function datasetWithEveryMac(base: SpecsDataset, appleDb: AppleDbSource, records: EveryMacRecord[]): SpecsDataset {
  const byUrl = new Map<string, EveryMacRecord>();
  for (const record of records) {
    const prev = byUrl.get(record.url);
    if (!prev || String(record.fetchedAt) >= String(prev.fetchedAt)) byUrl.set(record.url, record);
  }
  if (!byUrl.size) return base;
  const knownIds = new Set([...normalizeAppleDb(appleDb).models.map((m) => m.id), ...base.models.map((m) => m.id)]);
  const { entries } = recordsToDatasetEntries([...byUrl.values()], knownIds);
  const latest = [...byUrl.values()].map((r) => String(r.fetchedAt).slice(0, 10)).sort().slice(-1)[0];
  return mergeEveryMacEntries(base, entries, `${base.version}+everymac.${byUrl.size}.${latest}`);
}
const SNAPSHOTS_TO_KEEP = 3;
const CACHE_CHECK_MS = 60_000;
/** Familias de AppleDB conocidas al 2026-10-22; un tipo nuevo queda pendiente de clasificación. */
export const KNOWN_APPLEDB_TYPES = new Set<string>([
  ...APPLEDB_SOURCE_TYPES,
  'Accessories', 'Cases', 'Adapters', 'AirPort', 'AirTag', 'Apple Pencil', 'Apple TV', 'Audio', 'Batteries',
  'Beats Earbuds', 'Beats Headphones', 'Beats Speakers', 'Beddit', 'Bluetooth', 'Compute Module', 'Credit Cards',
  'Display', 'Graphics Cards', 'HomePod', 'Apple HomeView', 'Keyboard', 'MacBook', 'Macintosh', 'Module', 'Mouse',
  'Network Card', 'Other', 'Power', 'PowerBook', 'PowerMac', 'Remote', 'SDK', 'Storage', 'Security', 'Simulator',
  'Software', 'Trackpad', 'Virtual Machine', 'Headset', 'Xserve', 'eMac', 'iBook', 'iBridge', 'iPod', 'iPod shuffle',
  'iPod mini', 'iPod nano', 'iPod touch',
]);
const FAMILY_TYPES: Record<string, string[]> = {
  iphone: ['iPhone'],
  ipad: ['iPad', 'iPad mini', 'iPad Air', 'iPad Pro'],
  watch: ['Apple Watch'],
  airpods: ['AirPods'],
  mac: ['MacBook Air', 'MacBook Pro', 'iMac', 'Mac mini'],
};

interface SyncState {
  activeSnapshotId?: number | null;
  activeHash?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastResult?: string | null;
  lastError?: string | null;
  lastDiff?: Record<string, any> | null;
  pendingReview?: string[];
  intervalHours?: number;
}

export interface SyncOutcome {
  status: 'published' | 'unchanged' | 'not_modified' | 'rejected' | 'failed' | 'skipped_locked';
  detail?: string;
  version?: string;
  diff?: Record<string, any>;
}

/** Valida la estructura de un dataset complementario importado (JSON). */
export function validateSpecsDataset(raw: any): { dataset?: SpecsDataset; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { errors: ['El dataset debe ser un objeto JSON.'] };
  const version = String(raw.version || '').trim();
  if (!/^[0-9A-Za-z.\-_]{3,40}$/.test(version)) errors.push('version inválida (3-40 caracteres alfanuméricos, punto o guion).');
  if (!Array.isArray(raw.models) || !raw.models.length) errors.push('models debe ser un array no vacío.');
  const allowedSources = ['apple_official', 'everymac', 'curated', 'project_rules', 'override', 'appledb', 'appledb:name', 'legacy_admin_option'];
  const factKeys = ['storages', 'screens', 'caseSizesMm', 'connectivity', 'macCombos', 'imeiCount', 'battery', 'anc', 'caseConnector', 'colors', 'hardwareModels', 'orderCodes', 'weightKg'];
  const ids = new Set<string>();
  for (const [index, model] of (Array.isArray(raw.models) ? raw.models : []).entries()) {
    const where = `models[${index}]`;
    if (!model || typeof model.id !== 'string' || !/^[a-z0-9-]{3,80}$/.test(model.id)) { errors.push(`${where}.id inválido.`); continue; }
    if (ids.has(model.id)) errors.push(`${where}.id duplicado (${model.id}).`);
    ids.add(model.id);
    for (const key of Object.keys(model)) {
      if (!['id', 'tipo', 'listed', 'title', 'detalle', 'detalleAliases', 'aliases', 'conflicts', ...factKeys].includes(key)) errors.push(`${where}.${key}: campo no reconocido (queda pendiente de revisión).`);
    }
    for (const key of factKeys) {
      const value = model[key];
      if (value === undefined) continue;
      if (!value || typeof value !== 'object' || !('value' in value) || !value.provenance) { errors.push(`${where}.${key}: se espera {value, provenance}.`); continue; }
      if (!allowedSources.includes(value.provenance.source)) errors.push(`${where}.${key}.provenance.source inválido.`);
      if (value.provenance.source === 'apple_official' && (!value.provenance.url || !value.provenance.verifiedAt)) errors.push(`${where}.${key}: un dato oficial requiere url y verifiedAt.`);
    }
    if (model.tipo !== undefined && !(CATALOG_TIPOS as string[]).includes(model.tipo)) errors.push(`${where}.tipo inválido.`);
    if (model.storages && !(Array.isArray(model.storages.value) && model.storages.value.every((v: any) => /^\d+(TB)?$/.test(String(v))))) errors.push(`${where}.storages: valores como "128" o "1TB".`);
    if (model.imeiCount && ![0, 1, 2].includes(model.imeiCount.value)) errors.push(`${where}.imeiCount: 0, 1 o 2.`);
    if (model.anc && typeof model.anc.value !== 'boolean') errors.push(`${where}.anc: booleano (omitir si es desconocido).`);
    if (model.macCombos && !(Array.isArray(model.macCombos.value) && model.macCombos.value.every((c: any) => Array.isArray(c?.ram) && Array.isArray(c?.almacenamiento)))) errors.push(`${where}.macCombos: [{ram:[], almacenamiento:[]}].`);
  }
  if (errors.length) return { errors };
  return { dataset: { version, publishedAt: String(raw.publishedAt || new Date().toISOString().slice(0, 10)), description: raw.description, models: raw.models }, errors };
}

const isoNow = () => new Date().toISOString();
/** Versiones como "2026.10.22-10" se comparan numéricamente por tramos (no como texto). */
export const compareVersions = (a: string, b: string) => String(a).localeCompare(String(b), undefined, { numeric: true });

@Injectable()
export class AppleCatalogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppleCatalogService.name);
  private cached: { key: string; catalog: ConsolidatedCatalog; checkedAt: number } | null = null;
  private loading: Promise<ConsolidatedCatalog> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(CatalogItem) private readonly repo: Repository<CatalogItem>,
    private readonly dataSource: DataSource,
    private readonly provider: AppleDbProvider,
    private readonly everymac: EveryMacProvider,
  ) {}

  // ---------------- Programación ----------------
  onModuleInit() {
    const env = String(process.env.NODE_ENV || '').toLowerCase();
    const hours = Number(process.env.APPLE_CATALOG_SYNC_INTERVAL_HOURS ?? 24);
    if (env === 'test' || !Number.isFinite(hours) || hours <= 0) return;
    const run = () => this.syncNow('scheduled').catch((error) => this.logger.warn(`Sincronización programada fallida: ${error?.message || error}`));
    this.firstRun = setTimeout(run, Number(process.env.APPLE_CATALOG_SYNC_FIRST_DELAY_MS || 5 * 60_000));
    this.firstRun.unref?.();
    this.timer = setInterval(run, hours * 3600_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.firstRun) clearTimeout(this.firstRun);
  }

  // ---------------- Lectura del catálogo consolidado ----------------
  private async stateRow(): Promise<CatalogItem | null> {
    return this.repo.findOne({ where: { kind: KIND_STATE as any, value: 'appledb' } });
  }

  /** Clave barata (sin leer la instantánea ni el dataset completos) para saber si el catálogo cambió. */
  private async inputsKey() {
    const [state, datasetHeads, overrideRows, legacyRows, everymacHeads] = await Promise.all([
      this.stateRow(),
      this.repo.find({ where: { kind: KIND_DATASET as any, active: true }, select: ['id', 'value'] }),
      this.repo.find({ where: { kind: KIND_OVERRIDE as any, active: true }, order: { id: 'ASC' } }),
      this.repo.find({ where: { kind: 'product_option', active: true }, order: { id: 'ASC' } }),
      this.repo.find({ where: { kind: KIND_EVERYMAC as any, active: true }, select: ['id', 'updatedAt'] }),
    ]);
    const meta = (state?.metadata || {}) as SyncState;
    const datasetHead = [...datasetHeads].sort((a, b) => compareVersions(b.value, a.value))[0];
    const key = hashJson([meta.activeSnapshotId || 'baseline', meta.activeHash || null, datasetHead?.id || null, datasetHead?.value || null,
      overrideRows.map((o) => [o.id, o.metadata]), legacyRows.map((o) => [o.id, o.metadata]),
      everymacHeads.map((r) => [r.id, r.updatedAt ? new Date(r.updatedAt).getTime() : 0]), EVERYMAC_SEED.length]);
    return { key, meta, datasetHead, overrideRows, legacyRows, everymacCount: everymacHeads.length };
  }

  private async loadInputs() {
    const { key, meta, datasetHead, overrideRows, legacyRows, everymacCount } = await this.inputsKey();
    const datasetRow = datasetHead ? await this.repo.findOne({ where: { id: datasetHead.id, kind: KIND_DATASET as any } }) : null;
    let appleDb: AppleDbSource = APPLEDB_BASELINE;
    let appleDbHash = hashJson({ devices: APPLEDB_BASELINE.devices, groups: APPLEDB_BASELINE.groups });
    if (meta.activeSnapshotId) {
      const snapshot = await this.repo.findOne({ where: { id: meta.activeSnapshotId, kind: KIND_SNAPSHOT as any } });
      if (snapshot?.metadata?.source?.devices?.length) {
        appleDb = snapshot.metadata.source as AppleDbSource;
        appleDbHash = snapshot.value;
      }
    }
    const imported = datasetRow?.metadata?.dataset as SpecsDataset | undefined;
    // Un dataset importado solo reemplaza al empaquetado si su versión es posterior.
    const baseDataset = imported && compareVersions(String(imported.version), APPLE_SPECS_DATASET.version) > 0 ? imported : APPLE_SPECS_DATASET;
    const everymacRows = everymacCount ? await this.repo.find({ where: { kind: KIND_EVERYMAC as any, active: true }, order: { id: 'ASC' } }) : [];
    const everymacRecords = [...EVERYMAC_SEED, ...everymacRows.map((row) => row.metadata?.record as EveryMacRecord).filter(Boolean)];
    const dataset = datasetWithEveryMac(baseDataset, appleDb, everymacRecords);
    const overrides: CatalogOverride[] = overrideRows.map((row) => ({
      id: row.id,
      modelId: row.value,
      field: String(row.metadata?.field || ''),
      value: row.metadata?.value,
      reason: String(row.metadata?.reason || ''),
      author: row.metadata?.author || null,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
    }));
    const legacyOptions: LegacyProductOption[] = legacyRows.map((row) => ({ id: row.id, productType: row.productType, family: row.family, value: row.value, label: row.label, metadata: row.metadata }));
    return { key, appleDb, appleDbHash, dataset, overrides, legacyOptions };
  }

  async getCatalog(): Promise<ConsolidatedCatalog> {
    if (this.cached && Date.now() - this.cached.checkedAt < CACHE_CHECK_MS) return this.cached.catalog;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        if (this.cached) {
          const { key } = await this.inputsKey();
          if (this.cached.key === key) {
            this.cached.checkedAt = Date.now();
            return this.cached.catalog;
          }
        }
        const inputs = await this.loadInputs();
        const catalog = consolidateCatalog({ ...inputs });
        this.cached = { key: inputs.key, catalog, checkedAt: Date.now() };
        return catalog;
      } catch (error: any) {
        // Sin BD disponible (o tabla inaccesible) el catálogo empaquetado sigue sirviendo formularios.
        if (this.cached) return this.cached.catalog;
        this.logger.warn(`Catálogo Apple desde línea base empaquetada: ${error?.message || error}`);
        const catalog = consolidateCatalog({ appleDb: APPLEDB_BASELINE, appleDbHash: hashJson({ devices: APPLEDB_BASELINE.devices, groups: APPLEDB_BASELINE.groups }), dataset: datasetWithEveryMac(APPLE_SPECS_DATASET, APPLEDB_BASELINE, EVERYMAC_SEED) });
        this.cached = { key: 'baseline', catalog, checkedAt: Date.now() };
        return catalog;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  invalidate() {
    this.cached = null;
  }

  async forms(tipo?: string) {
    const catalog = await this.getCatalog();
    const type = String(tipo || '').toLowerCase();
    const models = catalog.models.filter((m) => !type || m.tipo === type);
    return {
      version: catalog.version,
      generatedAt: catalog.generatedAt,
      dataset: catalog.dataset,
      appleDb: { fetchedAt: catalog.appleDb.fetchedAt, license: catalog.appleDb.license },
      // Reglas de familia (selectores y campos no aplicables) para que el frontend no las duplique.
      families: Object.fromEntries(CATALOG_TIPOS.map((t) => [t, { selectors: FAMILY_SELECTORS[t], hiddenFields: FAMILY_HIDDEN_FIELDS[t] }])),
      models,
    };
  }

  async search(params: { q?: string; tipo?: string; page?: number; pageSize?: number }) {
    const catalog = await this.getCatalog();
    const q = String(params.q || '').trim().toLowerCase();
    const tipo = String(params.tipo || '').trim().toLowerCase();
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const page = Math.max(1, Number(params.page) || 1);
    const rows = catalog.models.filter((model) => {
      if (tipo && model.tipo !== tipo) return false;
      if (!q) return true;
      const haystack = [model.id, model.title, ...model.aliases, ...model.hardwareModels.map((h) => h.model), ...model.identifiers, ...(model.orderCodes || []).map((o) => o.code)].join(' ').toLowerCase();
      return q.split(/\s+/).every((part) => haystack.includes(part));
    });
    return {
      version: catalog.version,
      total: rows.length,
      page,
      pageSize,
      items: rows.slice((page - 1) * pageSize, page * pageSize).map((m) => ({ id: m.id, tipo: m.tipo, title: m.title, chip: m.chip, released: m.released, retired: Boolean(m.retired), needsReview: m.needsReview })),
    };
  }

  async getModel(id: string) {
    const catalog = await this.getCatalog();
    const model = catalog.models.find((m) => m.id === id);
    if (!model) throw new NotFoundException('Modelo no encontrado en el catálogo.');
    return { version: catalog.version, model };
  }

  async identify(text: string) {
    const catalog = await this.getCatalog();
    return { version: catalog.version, ...identifyFromText(catalog, String(text || '').slice(0, 500)) };
  }

  async resolve(tipo: string, detalle: Record<string, any>) {
    const catalog = await this.getCatalog();
    const result = resolveProductModel(catalog, tipo, detalle || {});
    return {
      version: catalog.version,
      status: result.status,
      modelId: result.model?.id || null,
      variantId: result.variant?.id || null,
      candidates: result.candidates,
      invalid: result.invalid,
    };
  }

  // ---------------- Reglas para Inventario y Productos ----------------
  /** Reglas de ficha para varias unidades con una sola carga del catálogo (sin N+1). */
  async inventoryRulesFor(productos: Array<{ id: number; tipo: string; estado?: string | null; detalle?: Record<string, any> | null }>) {
    const catalog = await this.getCatalog();
    const out = new Map<number, InventoryFieldRules & { candidates: Array<{ id: string; title: string }>; legacyInvalid: ModelResolution['invalid'] }>();
    for (const producto of productos) {
      out.set(producto.id, this.rulesWithCatalog(catalog, producto));
    }
    return out;
  }

  rulesWithCatalog(catalog: ConsolidatedCatalog, producto: { tipo: string; estado?: string | null; detalle?: Record<string, any> | null }) {
    const tipo = String(producto.tipo || '').toLowerCase();
    const detalle = producto.detalle || {};
    if (!(CATALOG_TIPOS as string[]).includes(tipo)) {
      return { ...inventoryFieldRules({ tipo, estado: producto.estado, resolution: 'not_catalog' }), candidates: [], legacyInvalid: [] };
    }
    const resolution = resolveProductModel(catalog, tipo, detalle);
    const connectivity = connectivityFromValue(detalle.conexion);
    const rules = inventoryFieldRules({
      tipo,
      estado: producto.estado,
      model: resolution.model,
      variant: resolution.variant,
      connectivity: resolution.variant ? undefined : connectivity,
      resolution: resolution.status,
    });
    return { ...rules, candidates: resolution.candidates, legacyInvalid: resolution.invalid };
  }

  completeness(values: Record<string, any>, rules: InventoryFieldRules) {
    return inventoryCompleteness(values, rules);
  }

  /**
   * Valida el `detalle` de un producto frente al catálogo. En alta, un modelo de familia del catálogo debe
   * estar identificado y sus selecciones ser válidas. En edición solo se validan los campos que cambian,
   * para no bloquear ni destruir datos legados.
   */
  async validateProductoDetalle(tipo: string, next: Record<string, any> | null | undefined, previous?: Record<string, any> | null) {
    const type = String(tipo || '').toLowerCase();
    if (!(CATALOG_TIPOS as string[]).includes(type) || !next) return { errors: [] as string[], warnings: [] as string[] };
    const catalog = await this.getCatalog();
    const merged = { ...(previous || {}), ...next };
    const changed = (field: string) => next[field] !== undefined && String(next[field] ?? '').trim() !== String(previous?.[field] ?? '').trim();
    const isCreate = !previous;
    const errors: string[] = [];
    const warnings: string[] = [];
    const identityFields = ['gama', 'procesador', 'generacion', 'numero', 'modelo'];
    const identityChanged = isCreate || identityFields.some(changed);
    const resolution = resolveProductModel(catalog, type, merged);
    if (resolution.status === 'ambiguous') {
      if (identityChanged) errors.push(`Modelo ambiguo: ${resolution.candidates.map((c) => c.title).join(' / ')}. Selecciona el modelo exacto.`);
      return { errors, warnings };
    }
    if (resolution.status === 'unknown') {
      // En alta la familia del catálogo exige elegir el modelo; en edición un legado sin cambios se conserva.
      if (isCreate || (identityChanged && Object.values(next).some((v) => String(v ?? '').trim()))) {
        errors.push('Modelo no reconocido en el catálogo Apple. Selecciónalo desde el catálogo o pide a un administrador que lo registre.');
      }
      return { errors, warnings };
    }
    for (const invalid of invalidSelections(resolution.model!, merged)) {
      const isHidden = (FAMILY_HIDDEN_FIELDS[resolution.model!.tipo] || []).includes(invalid.field);
      const fieldChanged = invalid.field === 'ram' && invalid.value.includes('/') ? changed('ram') || changed('almacenamiento') || changed('tamano') : changed(invalid.field);
      if (isCreate || fieldChanged || identityChanged) {
        errors.push(`${resolution.model!.title}: ${invalid.field} "${invalid.value}" — ${invalid.reason}`);
      } else {
        warnings.push(`${invalid.field} "${invalid.value}" es un valor legado pendiente de revisión${isHidden ? ' (campo no aplicable)' : ''}.`);
      }
    }
    // Opciones únicas comprobadas: deben guardarse (p. ej. pantalla del mini o tamaño del Ultra).
    for (const selector of resolution.model!.selectors) {
      if (selector.status !== 'confirmed' || selector.options.length !== 1) continue;
      if (!String(merged[selector.field] ?? '').trim() && (isCreate || identityChanged)) {
        errors.push(`${resolution.model!.title}: falta ${selector.label.toLowerCase()} (${selector.options[0].value}).`);
      }
    }
    return { errors, warnings };
  }

  // ---------------- Sincronización AppleDB ----------------
  private async saveState(patch: Partial<SyncState>) {
    let row = await this.stateRow();
    if (!row) row = this.repo.create({ kind: KIND_STATE as any, value: 'appledb', label: 'Sincronización AppleDB', active: true, metadata: {} });
    row.metadata = { ...(row.metadata || {}), ...patch };
    return this.repo.save(row);
  }

  async status() {
    const [state, snapshots, catalog] = await Promise.all([
      this.stateRow(),
      this.repo.find({ where: { kind: KIND_SNAPSHOT as any }, order: { id: 'DESC' }, take: SNAPSHOTS_TO_KEEP, select: ['id', 'value', 'createdAt', 'active'] }),
      this.getCatalog(),
    ]);
    const meta = (state?.metadata || {}) as SyncState;
    return {
      source: { name: 'AppleDB', url: APPLEDB_DEVICE_URL, license: catalog.appleDb.license, requiresKey: false },
      intervalHours: Number(process.env.APPLE_CATALOG_SYNC_INTERVAL_HOURS ?? 24),
      expectedLatency: 'AppleDB es comunitario: un lanzamiento aparece cuando la fuente lo publica; luego se detecta en la siguiente ejecución programada o con "Actualizar ahora".',
      usingBaseline: !meta.activeSnapshotId,
      catalogVersion: catalog.version,
      appleDbFetchedAt: catalog.appleDb.fetchedAt,
      dataset: catalog.dataset,
      overrides: catalog.overridesCount,
      conflicts: catalog.conflicts.filter((c) => !c.resolved).length,
      state: { ...meta, etag: meta.etag ? 'presente' : null },
      snapshots: snapshots.map((s) => ({ id: s.id, hash: s.value.slice(0, 12), createdAt: s.createdAt, active: s.id === meta.activeSnapshotId })),
    };
  }

  /** Comprueba el feed nuevo antes de publicarlo; ante dudas se conserva la versión válida anterior. */
  validateFeed(next: Pick<AppleDbSource, 'devices' | 'groups'>, previous: Pick<AppleDbSource, 'devices' | 'groups'>): string[] {
    const problems: string[] = [];
    const count = (src: Pick<AppleDbSource, 'devices'>, types: string[]) => src.devices.filter((d) => types.includes(d.type)).length;
    if (!next.devices.length) problems.push('El feed no contiene dispositivos de las familias comerciales.');
    if (previous.devices.length && next.devices.length < previous.devices.length * 0.8) {
      problems.push(`El feed bajó de ${previous.devices.length} a ${next.devices.length} dispositivos relevantes (>20%).`);
    }
    for (const [family, types] of Object.entries(FAMILY_TYPES)) {
      const before = count(previous, types);
      const after = count(next, types);
      if (before > 0 && after === 0) problems.push(`La familia ${family} quedó vacía.`);
    }
    if (!next.groups.length) problems.push('El feed de grupos está vacío.');
    return problems;
  }

  async syncNow(trigger: 'manual' | 'scheduled' = 'manual', author?: string | null): Promise<SyncOutcome> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    let locked = false;
    try {
      const lock = await runner.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', ['apple_catalog_sync']);
      locked = Boolean(lock?.[0]?.ok);
      if (!locked) return { status: 'skipped_locked', detail: 'Otra réplica está sincronizando.' };
      return await this.runSync(trigger, author);
    } finally {
      if (locked) await runner.query('SELECT pg_advisory_unlock(hashtext($1))', ['apple_catalog_sync']).catch(() => undefined);
      await runner.release();
    }
  }

  private async runSync(trigger: string, author?: string | null): Promise<SyncOutcome> {
    const startedAt = isoNow();
    const stateRow = await this.stateRow();
    const state = (stateRow?.metadata || {}) as SyncState;
    await this.saveState({ lastRunAt: startedAt, lastResult: 'running' });
    let fetched;
    try {
      fetched = await this.provider.fetchSource({ etag: state.etag, lastModified: state.lastModified });
    } catch (error: any) {
      await this.saveState({ lastResult: 'failed', lastError: `${startedAt}: ${error?.message || error}` });
      return { status: 'failed', detail: error?.message || String(error) };
    }
    if (fetched.notModified) {
      await this.saveState({ lastResult: 'not_modified', lastSuccessAt: isoNow(), lastError: null });
      return { status: 'not_modified' };
    }

    const newTypes = Array.from(new Set((fetched.devices || []).map((d: any) => String(d?.type || '')).filter((t) => t && !KNOWN_APPLEDB_TYPES.has(t))));
    const next = minimizeAppleDbSource(fetched.devices || [], fetched.groups || []);
    const inputs = await this.loadInputs();
    const previous = inputs.appleDb;
    const problems = this.validateFeed(next, previous);
    if (problems.length) {
      await this.saveState({ lastResult: 'rejected', lastError: `${startedAt}: ${problems.join(' ')}`, pendingReview: newTypes.map((t) => `Tipo AppleDB nuevo sin clasificar: ${t}`) });
      return { status: 'rejected', detail: problems.join(' ') };
    }

    // Modelos que desaparecen del feed se conservan consultables (marcados como retenidos).
    const nextKeys = new Set(next.devices.map((d) => d.key));
    const retainedDevices = previous.devices.filter((d) => !nextKeys.has(d.key));
    const source: AppleDbSource = {
      fetchedAt: startedAt,
      sourceUrl: APPLEDB_DEVICE_URL,
      etag: fetched.etag ?? null,
      lastModified: fetched.lastModified ?? null,
      devices: [...next.devices, ...retainedDevices].sort((a, b) => a.key.localeCompare(b.key)),
      groups: next.groups,
      retainedKeys: retainedDevices.map((d) => d.key),
    };
    const hash = hashJson({ devices: source.devices, groups: source.groups, retainedKeys: source.retainedKeys });
    const pendingReview = newTypes.map((t) => `Tipo AppleDB nuevo sin clasificar: ${t}`);
    if (hash === (state.activeHash || inputs.appleDbHash) && state.activeSnapshotId) {
      await this.saveState({ etag: fetched.etag ?? null, lastModified: fetched.lastModified ?? null, lastResult: 'unchanged', lastSuccessAt: isoNow(), lastError: null, pendingReview });
      return { status: 'unchanged' };
    }

    const before = consolidateCatalog({ ...inputs });
    const after = consolidateCatalog({ ...inputs, appleDb: source, appleDbHash: hash });
    const diff = this.diffCatalogs(before, after);
    diff.retained = source.retainedKeys!.length;
    diff.unclassified = after.report.unclassified.length;

    // Publicación idempotente: la misma instantánea (mismo hash) no se duplica.
    const snapshotId = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['apple_catalog_publish']);
      const repo = manager.getRepository(CatalogItem);
      let snapshot = await repo.findOne({ where: { kind: KIND_SNAPSHOT as any, value: hash } });
      if (!snapshot) {
        snapshot = await repo.save(repo.create({
          kind: KIND_SNAPSHOT as any,
          value: hash,
          label: `AppleDB ${startedAt.slice(0, 10)}`,
          active: true,
          metadata: { source, trigger, author: author || null, diff },
        }));
      }
      const old = await repo.find({ where: { kind: KIND_SNAPSHOT as any }, order: { id: 'DESC' }, select: ['id'] });
      const stale = old.slice(SNAPSHOTS_TO_KEEP).map((row) => row.id).filter((id) => id !== snapshot!.id);
      if (stale.length) await repo.delete({ id: In(stale) });
      return snapshot.id;
    });
    await this.saveState({
      activeSnapshotId: snapshotId,
      activeHash: hash,
      etag: fetched.etag ?? null,
      lastModified: fetched.lastModified ?? null,
      lastResult: 'published',
      lastSuccessAt: isoNow(),
      lastError: null,
      lastDiff: diff,
      pendingReview,
    });
    this.invalidate();
    const catalog = await this.getCatalog();
    return { status: 'published', version: catalog.version, diff };
  }

  diffCatalogs(before: ConsolidatedCatalog, after: ConsolidatedCatalog) {
    const prev = new Map(before.models.map((m) => [m.id, m]));
    const next = new Map(after.models.map((m) => [m.id, m]));
    const added = [...next.keys()].filter((id) => !prev.has(id));
    const removed = [...prev.keys()].filter((id) => !next.has(id));
    const changed = [...next.keys()].filter((id) => prev.has(id) && hashJson(prev.get(id)) !== hashJson(next.get(id)));
    return { added, removed, changed, retained: 0, unclassified: 0 } as Record<string, any>;
  }

  // ---------------- Dataset complementario ----------------
  async previewDataset(raw: any) {
    const { dataset, errors } = validateSpecsDataset(raw);
    if (!dataset) return { valid: false, errors };
    const inputs = await this.loadInputs();
    const before = consolidateCatalog({ ...inputs });
    const after = consolidateCatalog({ ...inputs, dataset });
    return {
      valid: true,
      errors: [],
      version: dataset.version,
      currentVersion: inputs.dataset.version,
      newerThanCurrent: compareVersions(dataset.version, inputs.dataset.version) > 0,
      diff: this.diffCatalogs(before, after),
      conflicts: after.conflicts.filter((c) => !c.resolved),
    };
  }

  async publishDataset(raw: any, author?: string | null) {
    const { dataset, errors } = validateSpecsDataset(raw);
    if (!dataset) throw new BadRequestException(errors.join(' '));
    const inputs = await this.loadInputs();
    const existing = await this.repo.findOne({ where: { kind: KIND_DATASET as any, value: dataset.version } });
    if (existing) {
      if (hashJson(existing.metadata?.dataset) === hashJson(dataset)) return { status: 'unchanged', version: dataset.version };
      throw new BadRequestException('Ya existe un dataset con esa versión y contenido distinto. Incrementa la versión.');
    }
    if (compareVersions(dataset.version, inputs.dataset.version) <= 0) throw new BadRequestException(`La versión debe ser posterior a ${inputs.dataset.version}.`);
    await this.repo.save(this.repo.create({ kind: KIND_DATASET as any, value: dataset.version, label: `Dataset ${dataset.version}`, active: true, metadata: { dataset, author: author || null, publishedAt: isoNow() } }));
    this.invalidate();
    const catalog = await this.getCatalog();
    return { status: 'published', version: dataset.version, catalogVersion: catalog.version };
  }

  // ---------------- Importación por enlaces de EveryMac ----------------
  private everymacRowValue(url: string) {
    return hashJson(url).slice(0, 40);
  }

  /**
   * Lee las fichas de los enlaces (una vez cada uno), muestra qué modelo/configuración aportan y, con
   * `save`, las guarda en la BD. Los formularios nunca consultan EveryMac: leen el catálogo guardado.
   */
  async everymacImport(rawUrls: unknown, save: boolean, author?: string | null) {
    const list = (Array.isArray(rawUrls) ? rawUrls : String(rawUrls || '').split(/\s+/)).map((u) => String(u || '').trim()).filter(Boolean);
    const urls = Array.from(new Set(list.map(normalizeEveryMacUrl)));
    if (!urls.length) throw new BadRequestException('Pega al menos un enlace de ficha de EveryMac.');
    if (urls.length > EVERYMAC_MAX_URLS) throw new BadRequestException(`Máximo ${EVERYMAC_MAX_URLS} enlaces por importación.`);

    const results: Array<{ url: string; ok: boolean; error?: string; record?: EveryMacRecord }> = [];
    for (const url of urls) {
      try {
        results.push({ url, ok: true, record: await this.everymac.getRecord(url) });
      } catch (error: any) {
        results.push({ url, ok: false, error: error?.message || String(error) });
      }
    }
    const records = results.filter((r) => r.ok && r.record).map((r) => r.record!);
    const inputs = await this.loadInputs();
    const knownIds = new Set([...normalizeAppleDb(inputs.appleDb).models.map((m) => m.id), ...inputs.dataset.models.map((m) => m.id)]);
    const before = consolidateCatalog({ ...inputs });
    const after = consolidateCatalog({ ...inputs, dataset: datasetWithEveryMac(inputs.dataset, inputs.appleDb, records) });
    const summary = results.map((result) => {
      const record = result.record;
      const mapped = record ? mapRecordToModel(record, knownIds) : null;
      const model = mapped ? after.models.find((m) => m.id === mapped.id) : null;
      return {
        url: result.url,
        ok: result.ok && Boolean(mapped),
        error: result.error || (!mapped && record ? 'No se pudo identificar el modelo comercial.' : undefined),
        modelId: mapped?.id || null,
        title: model?.title || mapped?.title || record?.title || null,
        nuevo: mapped ? !before.models.some((m) => m.id === mapped.id && m.listed) : false,
        config: record ? {
          chip: record.chip, nucleos: record.cpuCores ? `${record.cpuCores} CPU / ${record.gpuCores} GPU` : null,
          pantalla: record.screen, caja: record.caseSizeMm ? `${record.caseSizeMm} mm` : null, conectividad: record.connectivity,
          ram: record.ramOptions, almacenamiento: record.storageOptions, modelos: record.modelNumbers, identificadores: record.modelIds,
        } : null,
        warnings: record?.warnings || [],
      };
    });
    const diff = this.diffCatalogs(before, after);
    if (!save) return { mode: 'preview', results: summary, diff };

    const now = isoNow();
    for (const record of records) {
      if (!mapRecordToModel(record, knownIds)) continue;
      const value = this.everymacRowValue(record.url);
      let row = await this.repo.findOne({ where: { kind: KIND_EVERYMAC as any, value } });
      if (!row) row = this.repo.create({ kind: KIND_EVERYMAC as any, value, active: true });
      row.label = String(record.title || record.url).slice(0, 140);
      row.active = true;
      row.metadata = { record, url: record.url, author: author || null, importedAt: now };
      await this.repo.save(row);
    }
    this.invalidate();
    const catalog = await this.getCatalog();
    return { mode: 'import', saved: summary.filter((s) => s.ok).length, results: summary, diff, catalogVersion: catalog.version };
  }

  async everymacList() {
    const rows = await this.repo.find({ where: { kind: KIND_EVERYMAC as any }, order: { id: 'DESC' } });
    return {
      seed: EVERYMAC_SEED.length,
      imported: rows.map((row) => ({ id: row.id, active: row.active, url: row.metadata?.url, title: row.label, importedAt: row.metadata?.importedAt, author: row.metadata?.author })),
    };
  }

  async everymacDisable(id: number) {
    const row = await this.repo.findOne({ where: { id, kind: KIND_EVERYMAC as any } });
    if (!row) throw new NotFoundException('Ficha importada no encontrada.');
    row.active = false;
    await this.repo.save(row);
    this.invalidate();
    return { id, active: false };
  }

  /** Modelos que AppleDB ya publica pero no están en el alcance comercial: candidatos a subir su enlace. */
  async pendingModels() {
    const catalog = await this.getCatalog();
    const since = new Date(Date.now() - 2 * 365 * 86400_000).toISOString().slice(0, 10);
    return catalog.models
      .filter((m) => !m.listed && !m.retired && String(m.released || '') >= since)
      .map((m) => ({ id: m.id, tipo: m.tipo, title: m.title, released: m.released }))
      .sort((a, b) => String(b.released).localeCompare(String(a.released)));
  }

  // ---------------- Anulaciones administrativas ----------------
  async listOverrides() {
    const rows = await this.repo.find({ where: { kind: KIND_OVERRIDE as any }, order: { id: 'DESC' } });
    return rows.map((row) => ({ id: row.id, modelId: row.value, active: row.active, ...row.metadata, createdAt: row.createdAt }));
  }

  async createOverride(dto: any, author?: string | null) {
    const modelId = String(dto?.modelId || '').trim();
    const field = String(dto?.field || '').trim();
    const reason = String(dto?.reason || '').trim();
    const allowed = ['title', 'detalle', 'retired', 'listed', 'anc', 'colors', 'macCombos', 'imeiCount', 'battery', 'selectors.tamano', 'selectors.almacenamiento', 'selectors.ram', 'selectors.conexion'];
    if (!allowed.includes(field)) throw new BadRequestException(`Campo no admitido. Usa: ${allowed.join(', ')}.`);
    if (reason.length < 10) throw new BadRequestException('Indica la justificación y la fuente verificada (mínimo 10 caracteres).');
    const catalog = await this.getCatalog();
    if (!catalog.models.some((m) => m.id === modelId)) throw new NotFoundException('Modelo no encontrado en el catálogo.');
    const row = await this.repo.save(this.repo.create({
      kind: KIND_OVERRIDE as any,
      value: modelId,
      label: `${modelId}:${field}`.slice(0, 140),
      active: true,
      metadata: { field, value: dto?.value ?? null, reason, sourceUrl: dto?.sourceUrl || null, author: author || null, locked: true },
    }));
    this.invalidate();
    return { id: row.id, modelId, field };
  }

  async disableOverride(id: number) {
    const row = await this.repo.findOne({ where: { id, kind: KIND_OVERRIDE as any } });
    if (!row) throw new NotFoundException('Anulación no encontrada.');
    row.active = false;
    await this.repo.save(row);
    this.invalidate();
    return { id, active: false };
  }

  // ---------------- Cobertura y reconciliación ----------------
  async coverage() {
    const catalog = await this.getCatalog();
    return {
      version: catalog.version,
      appleDb: catalog.appleDb,
      dataset: catalog.dataset,
      classification: catalog.report,
      families: coverageReport(catalog),
      conflicts: catalog.conflicts,
      needsReview: catalog.models.filter((m) => m.needsReview.length).map((m) => ({ id: m.id, title: m.title, needsReview: m.needsReview })),
    };
  }

  /** Informe dry-run: no modifica productos, ventas, costos ni stock. */
  async reconcile(limit = 2000) {
    const catalog = await this.getCatalog();
    const rows: Array<Record<string, any>> = await this.dataSource.query(
      `SELECT p.id, p.tipo, p.estado, d.gama, d.procesador, d.generacion, d.numero, d.modelo, d.tamano, d.almacenamiento, d.ram, d.conexion
         FROM producto p LEFT JOIN producto_detalle d ON d.id = p."detalleId"
        WHERE LOWER(p.tipo) = ANY($1)
        ORDER BY p.id DESC
        LIMIT $2`,
      [CATALOG_TIPOS, Math.min(10000, Math.max(1, limit))],
    );
    const summary = { exact: 0, ambiguous: 0, unknown: 0, invalid: 0 };
    const items: any[] = [];
    for (const row of rows) {
      const detalle = { ...row };
      const resolution = resolveProductModel(catalog, row.tipo, detalle);
      let status: keyof typeof summary = resolution.status;
      if (resolution.status === 'exact' && resolution.invalid.length) status = 'invalid';
      summary[status]++;
      const proposals: Record<string, string> = {};
      if (resolution.model) {
        for (const selector of resolution.model.selectors) {
          if (selector.status === 'confirmed' && selector.options.length === 1 && !String(detalle[selector.field] ?? '').trim()) {
            proposals[selector.field] = selector.options[0].value;
          }
        }
      }
      if (status !== 'exact' || Object.keys(proposals).length) {
        items.push({
          productoId: row.id,
          tipo: row.tipo,
          status,
          modelId: resolution.model?.id || null,
          candidates: resolution.candidates,
          invalid: resolution.invalid,
          proposals,
        });
      }
    }
    return { version: catalog.version, mode: 'dry-run', scanned: rows.length, summary, items };
  }

  tipos(): CatalogTipo[] {
    return CATALOG_TIPOS;
  }
}
