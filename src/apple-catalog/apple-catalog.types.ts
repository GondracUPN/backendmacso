// Contrato del catálogo Apple consolidado. Distingue:
//  - modelo comercial (AppleCatalogModel): lo que se elige en Productos;
//  - variante (AppleCatalogVariant): conectividad/tamaño/región que cambia IMEI o identificadores;
//  - unidad física: ficha de Inventario (serial/IMEI/color). Nunca se crea desde el catálogo.

/** Tipos de producto existentes en `producto.tipo` que consumen el catálogo. */
export type CatalogTipo = 'iphone' | 'ipad' | 'watch' | 'macbook' | 'imac' | 'macmini' | 'airpods';
export const CATALOG_TIPOS: CatalogTipo[] = ['iphone', 'ipad', 'watch', 'macbook', 'imac', 'macmini', 'airpods'];

/**
 * Procedencia de un dato. `apple_official`: contrastado con la ficha oficial enlazada en la fecha indicada.
 * `curated`: conocimiento del equipo/reglas previas pendiente de contraste oficial.
 * `appledb` / `appledb:name`: campo estructurado de AppleDB o extraído del nombre del dispositivo.
 */
export type ProvenanceSource =
  | 'override'
  | 'apple_official'
  | 'curated'
  | 'everymac'
  | 'project_rules'
  | 'legacy_admin_option'
  | 'appledb'
  | 'appledb:name';

export interface Provenance {
  source: ProvenanceSource;
  url?: string;
  verifiedAt?: string;
  license?: string;
  note?: string;
}

export type FieldStatus = 'confirmed' | 'unknown' | 'not_applicable';

// ---------- Fuente AppleDB (subconjunto mínimo) ----------
export interface AppleDbColor {
  key?: string;
  name: string;
  /** AppleDB usa a veces dos tonos (array). */
  hex?: string | string[];
}
export interface AppleDbDevice {
  key: string;
  name: string;
  type: string;
  identifier?: string | string[];
  model?: string | string[];
  soc?: string | string[];
  released?: string | string[];
  discontinued?: string | string[];
  internal?: boolean;
  colors?: AppleDbColor[];
  info?: Array<Record<string, any>>;
}
export interface AppleDbGroup {
  key: string;
  name: string;
  type: string;
  devices: string[];
}
export interface AppleDbSource {
  fetchedAt: string;
  sourceUrl: string;
  etag?: string | null;
  lastModified?: string | null;
  devices: AppleDbDevice[];
  groups: AppleDbGroup[];
  /** Dispositivos conservados de una versión anterior porque desaparecieron del feed. */
  retainedKeys?: string[];
}

// ---------- Resultado normalizado de AppleDB ----------
export type Connectivity = 'wifi' | 'cellular' | 'gps' | 'gps_cellular';

export interface NormalizedVariant {
  id: string;
  name: string;
  appleDbKeys: string[];
  hardwareModels: string[];
  identifiers: string[];
  connectivity?: Connectivity | null;
  /** iPad/Mac: pantalla comercial en pulgadas leída del nombre. Watch: tamaño de caja en mm. */
  size?: string | null;
  colors: AppleDbColor[];
}

export interface NormalizedModel {
  id: string;
  tipo: CatalogTipo;
  appleDbType: string;
  title: string;
  detalle: Record<string, string>;
  chip?: string | null;
  released?: string | null;
  discontinued?: string | null;
  appleDbGroups: string[];
  variants: NormalizedVariant[];
  memory?: { ram: string[]; storage: string[] } | null;
  displayDiagonal?: string | null;
  /** AirPods: piezas del conjunto (izquierdo/derecho/estuche). No son unidades de stock. */
  components?: Array<{ key: string; name: string; role: 'left' | 'right' | 'case' | 'other' }>;
  /** AirPods: generación sin el sufijo de edición (con/sin ANC, estuche, USB-C). */
  generation?: string;
  needsReview: string[];
}

export type ClassificationBucket =
  | 'commercial'
  | 'out_of_window'
  | 'intel_legacy'
  | 'catalog_only'
  | 'component'
  | 'unreleased_or_internal'
  | 'unclassified';

export interface NormalizationReport {
  totalDevices: number;
  byBucket: Record<ClassificationBucket, number>;
  unclassified: Array<{ key: string; name: string; type: string }>;
}

// ---------- Dataset complementario y anulaciones ----------
export interface DatasetFact<T> {
  value: T;
  provenance: Provenance;
}

export interface MacCombo {
  tamano?: string[];
  ram: string[];
  almacenamiento: string[];
}

export interface DatasetModelEntry {
  id: string;
  /** Solo para modelos manuales (sin equivalente en AppleDB todavía): familia del producto. */
  tipo?: CatalogTipo;
  /** Modelo dentro del alcance comercial: aparece en los selectores de Productos/Inventario. */
  listed?: boolean;
  title?: string;
  detalle?: Record<string, string>;
  /** Combinaciones legadas de `detalle` que identifican el mismo modelo (p. ej. generacion 'A16' y '11'). */
  detalleAliases?: Array<Record<string, string>>;
  aliases?: string[];
  storages?: DatasetFact<string[]>;
  screens?: DatasetFact<Array<{ value: string; diagonal?: string }>>;
  caseSizesMm?: DatasetFact<string[]>;
  connectivity?: DatasetFact<Connectivity[]>;
  macCombos?: DatasetFact<MacCombo[]>;
  imeiCount?: DatasetFact<0 | 1 | 2>;
  battery?: DatasetFact<Partial<BatteryCapabilities>>;
  anc?: DatasetFact<boolean>;
  caseConnector?: DatasetFact<string>;
  colors?: DatasetFact<Array<{ name: string; label?: string; hex?: string; tamano?: string }>>;
  hardwareModels?: DatasetFact<Array<{ model: string; variant?: Record<string, string>; region?: string }>>;
  orderCodes?: DatasetFact<Array<{ code: string; config: Record<string, string> }>>;
  weightKg?: DatasetFact<Record<string, number>>;
  /** Discrepancias conocidas entre fuentes que requieren revisión explícita. */
  conflicts?: Array<{ field: string; detail: string; sources: Provenance[]; resolved?: boolean }>;
}

export interface SpecsDataset {
  version: string;
  publishedAt: string;
  description?: string;
  models: DatasetModelEntry[];
}

export interface CatalogOverride {
  id?: number;
  modelId: string;
  field: string;
  value: any;
  reason: string;
  author?: string | null;
  createdAt?: string;
}

// ---------- Capacidades por modelo/variante ----------
export type BatteryMetricSource = 'native' | 'manual' | 'none';
export interface BatteryCapabilities {
  hasBattery: boolean;
  health: BatteryMetricSource;
  cycles: BatteryMetricSource;
}
export interface IdentifierCapabilities {
  serial: boolean;
  imeiCount: 0 | 1 | 2;
  /** `unknown` cuando el número de IMEI no está comprobado para el modelo. */
  imeiStatus: FieldStatus;
}
export interface DeviceCapabilities {
  identifiers: IdentifierCapabilities;
  battery: BatteryCapabilities;
}

// ---------- Catálogo consolidado servido a los formularios ----------
export interface SelectorOption {
  value: string;
  label: string;
  diagonal?: string;
}
export interface CatalogSelector {
  field: 'tamano' | 'almacenamiento' | 'ram' | 'conexion' | 'procesador';
  label: string;
  unit?: 'in' | 'mm' | 'GB' | null;
  status: FieldStatus;
  options: SelectorOption[];
  provenance?: Provenance | null;
}

export interface AppleCatalogVariant {
  id: string;
  label: string;
  connectivity?: Connectivity | null;
  size?: string | null;
  /** Valores de `detalle` que esta variante fija (por ejemplo conexion/tamano del Watch). */
  detalle: Record<string, string>;
  hardwareModels: string[];
  identifiers: string[];
  appleDbKeys: string[];
  capabilities: DeviceCapabilities;
}

export interface AppleCatalogColor {
  id: string;
  name: string;
  label: string;
  hex?: string | null;
  tamano?: string | null;
  provenance: Provenance;
}

export interface AppleCatalogModel {
  id: string;
  tipo: CatalogTipo;
  title: string;
  /** Valores canónicos de `producto_detalle` que identifican el modelo (instantánea por valor). */
  detalle: Record<string, string>;
  detalleAliases: Array<Record<string, string>>;
  aliases: string[];
  chip?: string | null;
  released?: string | null;
  discontinued?: string | null;
  selectors: CatalogSelector[];
  macCombos?: MacCombo[] | null;
  variants: AppleCatalogVariant[];
  colors: AppleCatalogColor[];
  colorStatus: FieldStatus;
  capabilities: DeviceCapabilities;
  airpods?: { generation: string; anc: boolean | null; ancSelectable: boolean; caseLabel?: string | null } | null;
  hardwareModels: Array<{ model: string; variantId?: string | null }>;
  identifiers: string[];
  orderCodes?: Array<{ code: string; config: Record<string, string> }>;
  weightKg?: Record<string, number> | null;
  fieldStatus: Record<string, FieldStatus>;
  provenance: Record<string, Provenance>;
  sources: { appleDbKeys: string[]; appleDbGroups: string[]; datasetVersion?: string | null };
  conflicts: Array<{ field: string; detail: string; resolved?: boolean }>;
  needsReview: string[];
  retired?: boolean;
  /** Dentro del alcance comercial (EveryMac o dataset). Los no listados solo se resuelven/consultan. */
  listed: boolean;
}

export interface CatalogConflict {
  modelId: string;
  field: string;
  detail: string;
  resolved?: boolean;
}

export interface ConsolidatedCatalog {
  version: string;
  generatedAt: string;
  appleDb: { fetchedAt: string; hash: string; sourceUrl: string; license: string; retainedKeys: string[] };
  dataset: { version: string; publishedAt: string };
  overridesCount: number;
  models: AppleCatalogModel[];
  conflicts: CatalogConflict[];
  report: NormalizationReport;
}
