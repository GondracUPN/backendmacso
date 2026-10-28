// Reglas comerciales propias (no vienen del proveedor): qué selectores muestra cada familia,
// qué identificadores admite una unidad y qué métricas de batería son aplicables.
// Backend y frontend consumen el mismo resultado: el frontend no recalcula estas reglas.
import type {
  AppleCatalogModel,
  AppleCatalogVariant,
  BatteryCapabilities,
  CatalogSelector,
  CatalogTipo,
  Connectivity,
  DeviceCapabilities,
} from './apple-catalog.types';

/** Matriz de selectores comerciales tras elegir el modelo (sección 5 del requisito). */
export const FAMILY_SELECTORS: Record<CatalogTipo, Array<CatalogSelector['field']>> = {
  iphone: ['almacenamiento'],
  ipad: ['tamano', 'almacenamiento', 'conexion'],
  watch: ['tamano', 'conexion'],
  macbook: ['tamano', 'ram', 'almacenamiento'],
  imac: ['tamano', 'ram', 'almacenamiento'],
  macmini: ['ram', 'almacenamiento'],
  airpods: [],
};

/** Campos de `detalle` que la familia no muestra ni exige; un valor nuevo se rechaza (los legados se conservan). */
export const FAMILY_HIDDEN_FIELDS: Record<CatalogTipo, string[]> = {
  iphone: ['ram', 'tamano', 'conexion'],
  ipad: ['ram'],
  watch: ['ram', 'almacenamiento'],
  macbook: ['conexion', 'esim'],
  imac: ['conexion', 'esim'],
  macmini: ['tamano', 'conexion', 'esim'],
  airpods: ['ram', 'almacenamiento', 'tamano', 'procesador', 'conexion', 'esim'],
};

export const SELECTOR_LABELS: Record<CatalogSelector['field'], { label: string; unit: CatalogSelector['unit'] }> = {
  tamano: { label: 'Pantalla', unit: 'in' },
  almacenamiento: { label: 'Almacenamiento', unit: 'GB' },
  ram: { label: 'Memoria unificada (RAM)', unit: 'GB' },
  conexion: { label: 'Conectividad', unit: null },
  procesador: { label: 'Chip', unit: null },
};

/** Valores persistidos en `detalle.conexion` (se mantienen los ya usados por productos existentes). */
export const CONNECTIVITY_VALUE: Record<Connectivity, string> = {
  wifi: 'Wifi',
  cellular: 'Wifi + Cel',
  gps: 'GPS',
  gps_cellular: 'GPS + Cel',
};
export const CONNECTIVITY_LABEL: Record<Connectivity, string> = {
  wifi: 'Wi-Fi',
  cellular: 'Wi-Fi + Cellular',
  gps: 'GPS',
  gps_cellular: 'GPS + Cellular',
};

export function connectivityFromValue(value: unknown): Connectivity | null {
  const text = String(value ?? '').toLowerCase().replace(/\s+/g, '');
  if (!text) return null;
  if (text.includes('gps')) return /cel|lte|cellular/.test(text) ? 'gps_cellular' : 'gps';
  if (/cel|lte|cellular/.test(text)) return 'cellular';
  if (text.includes('wifi') || text.includes('wi-fi')) return 'wifi';
  return null;
}

export const DEFAULT_BATTERY: Record<CatalogTipo, BatteryCapabilities> = {
  iphone: { hasBattery: true, health: 'native', cycles: 'manual' },
  ipad: { hasBattery: true, health: 'manual', cycles: 'manual' },
  watch: { hasBattery: true, health: 'native', cycles: 'none' },
  macbook: { hasBattery: true, health: 'native', cycles: 'native' },
  imac: { hasBattery: false, health: 'none', cycles: 'none' },
  macmini: { hasBattery: false, health: 'none', cycles: 'none' },
  // AirPods tienen batería, pero el negocio no registra porcentaje de salud ni ciclos (nivel de carga es otra magnitud).
  airpods: { hasBattery: true, health: 'none', cycles: 'none' },
};

/** Capacidades de identificación por familia y conectividad (sin variante conocida → estado desconocido). */
export function identifierCapabilities(tipo: CatalogTipo, connectivity: Connectivity | null | undefined, datasetImei?: 0 | 1 | 2 | null) {
  if (tipo === 'iphone') {
    return { serial: true, imeiCount: (datasetImei ?? 2) as 0 | 1 | 2, imeiStatus: datasetImei === undefined || datasetImei === null ? 'unknown' as const : 'confirmed' as const };
  }
  if (tipo === 'ipad' || tipo === 'watch') {
    if (!connectivity) return { serial: true, imeiCount: 1 as const, imeiStatus: 'unknown' as const };
    const cellular = connectivity === 'cellular' || connectivity === 'gps_cellular';
    return { serial: true, imeiCount: (cellular ? 1 : 0) as 0 | 1, imeiStatus: 'confirmed' as const };
  }
  // Mac y AirPods: serial, nunca IMEI.
  return { serial: true, imeiCount: 0 as const, imeiStatus: 'confirmed' as const };
}

export function buildCapabilities(
  tipo: CatalogTipo,
  connectivity: Connectivity | null | undefined,
  datasetImei?: 0 | 1 | 2 | null,
  battery?: Partial<BatteryCapabilities> | null,
): DeviceCapabilities {
  return {
    identifiers: identifierCapabilities(tipo, connectivity, datasetImei),
    battery: { ...DEFAULT_BATTERY[tipo], ...(battery || {}) },
  };
}

// ---------------- Identificadores de unidad ----------------
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** IMEI como texto de 15 dígitos (conserva ceros iniciales). Un checksum válido no prueba autenticidad. */
export function normalizeImei(value: unknown): { value: string | null; error?: string } {
  const raw = String(value ?? '').trim();
  if (!raw) return { value: null };
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{15}$/.test(digits)) return { value: null, error: 'El IMEI debe tener 15 dígitos.' };
  if (!luhnValid(digits)) return { value: null, error: 'El IMEI no supera la comprobación de integridad (Luhn).' };
  return { value: digits };
}

/** Serial Apple normalizado (mayúsculas, sin espacios). Formatos de 10-12 caracteres y aleatorios son válidos. */
export function normalizeSerial(value: unknown): { value: string | null; error?: string } {
  const raw = String(value ?? '').trim();
  if (!raw) return { value: null };
  const compact = raw.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{5,24}$/.test(compact)) return { value: null, error: 'El serial solo admite letras y números (5 a 24 caracteres).' };
  return { value: compact };
}

// ---------------- Reglas de la ficha de Inventario ----------------
export interface InventoryFieldRule {
  visible: boolean;
  requiredForComplete: boolean;
  source?: 'native' | 'manual' | 'none';
}
export interface InventoryFieldRules {
  tipo: CatalogTipo | null;
  modelId: string | null;
  resolution: 'exact' | 'ambiguous' | 'unknown' | 'not_catalog';
  serial: InventoryFieldRule;
  imei: InventoryFieldRule;
  imei2: InventoryFieldRule;
  saludBateria: InventoryFieldRule;
  ciclosBateria: InventoryFieldRule;
  color: InventoryFieldRule & { options: Array<{ value: string; label: string; hex?: string | null; aliases?: string[] }>; status: 'confirmed' | 'unknown' };
  imeiStatus: 'confirmed' | 'unknown' | 'not_applicable';
}

const NONE: InventoryFieldRule = { visible: false, requiredForComplete: false };

export function inventoryFieldRules(params: {
  tipo: string;
  estado?: string | null;
  model?: AppleCatalogModel | null;
  variant?: AppleCatalogVariant | null;
  connectivity?: Connectivity | null;
  resolution: InventoryFieldRules['resolution'];
}): InventoryFieldRules {
  const tipo = String(params.tipo || '').toLowerCase() as CatalogTipo;
  const isCatalog = (['iphone', 'ipad', 'watch', 'macbook', 'imac', 'macmini', 'airpods'] as string[]).includes(tipo);
  const sealed = String(params.estado || '').toLowerCase() === 'nuevo';
  if (!isCatalog) {
    // Otros equipos: capacidades desconocidas (no "no aplicables"). Todo opcional y nunca requerido;
    // un IMEI informado igualmente debe ser válido. Accesorios por cantidad no usan esta ficha.
    const accessory = String(params.tipo || '').toLowerCase() === 'accesorios';
    const optional: InventoryFieldRule = accessory ? NONE : { visible: true, requiredForComplete: false };
    const battery: InventoryFieldRule = accessory || sealed ? { ...NONE, source: 'none' } : { visible: true, requiredForComplete: false, source: 'manual' };
    return {
      tipo: null,
      modelId: null,
      resolution: 'not_catalog',
      serial: optional,
      imei: optional,
      imei2: optional,
      saludBateria: battery,
      ciclosBateria: battery,
      color: { ...optional, options: [], status: 'unknown' },
      imeiStatus: accessory ? 'not_applicable' : 'unknown',
    };
  }
  // Prioridad: variante resuelta > conectividad declarada en el producto > modelo > reglas de la familia.
  const caps = params.variant?.capabilities
    ?? ((tipo === 'ipad' || tipo === 'watch') && params.connectivity
      ? buildCapabilities(tipo, params.connectivity, null, params.model?.capabilities.battery)
      : params.model?.capabilities)
    ?? buildCapabilities(tipo, params.connectivity ?? null);
  const imeiCount = caps.identifiers.imeiCount;
  const imeiKnown = caps.identifiers.imeiStatus === 'confirmed';
  const battery = caps.battery;
  const colorOptions = (params.model?.colors || [])
    .filter((color) => !color.tamano || !params.variant?.size || color.tamano === params.variant.size || color.tamano === params.variant.detalle?.tamano)
    // Inventario usa el acabado original en inglés; la traducción previa sigue siendo un alias válido.
    .map((color) => ({ value: color.name, label: color.name, hex: color.hex ?? null, aliases: [color.label] }));
  return {
    tipo,
    modelId: params.model?.id || null,
    resolution: params.resolution,
    serial: { visible: true, requiredForComplete: true },
    imei: { visible: imeiCount >= 1, requiredForComplete: imeiCount >= 1 && imeiKnown },
    imei2: { visible: imeiCount >= 2, requiredForComplete: imeiCount >= 2 && imeiKnown },
    saludBateria: battery.health !== 'none' && !sealed
      ? { visible: true, requiredForComplete: false, source: battery.health }
      : { ...NONE, source: 'none' },
    ciclosBateria: battery.cycles !== 'none' && !sealed
      ? { visible: true, requiredForComplete: false, source: battery.cycles }
      : { ...NONE, source: 'none' },
    color: {
      visible: true,
      requiredForComplete: colorOptions.length > 1,
      options: colorOptions,
      status: colorOptions.length ? 'confirmed' : 'unknown',
    },
    imeiStatus: imeiCount === 0 && imeiKnown ? 'not_applicable' : imeiKnown ? 'confirmed' : 'unknown',
  };
}

export interface InventoryValues {
  serial?: string | null;
  imei?: string | null;
  imei2?: string | null;
  color?: string | null;
  saludBateria?: number | null;
  ciclosBateria?: number | null;
}

const same = (a: unknown, b: unknown) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * Valida un PATCH de ficha frente a las reglas del modelo. Un valor incompatible nuevo o cambiado se rechaza;
 * un valor legado que no cambia se conserva y se informa para revisión (no se borra en silencio).
 */
export function validateInventoryValues(input: InventoryValues, stored: InventoryValues, rules: InventoryFieldRules) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patch: InventoryValues = {};

  const checkHidden = (field: keyof InventoryValues, rule: InventoryFieldRule, label: string) => {
    const value = input[field];
    if (value === undefined) return false;
    if (rule.visible) return false;
    if (value === null || value === '') return true; // limpiar un valor no aplicable es válido
    if (same(value, stored[field])) {
      warnings.push(`${label}: valor legado conservado aunque no aplica a este modelo; requiere revisión.`);
      return true;
    }
    errors.push(`${label} no aplica a este modelo.`);
    return true;
  };

  if (input.serial !== undefined && !checkHidden('serial', rules.serial, 'Serial')) {
    const serial = normalizeSerial(input.serial);
    if (serial.error && !same(input.serial, stored.serial)) errors.push(serial.error);
    else patch.serial = serial.error ? String(input.serial).trim() : serial.value;
  }
  for (const [field, label] of [['imei', 'IMEI 1'], ['imei2', 'IMEI 2']] as const) {
    if (input[field] === undefined) continue;
    if (checkHidden(field, rules[field], label)) {
      if (input[field] === null || input[field] === '') patch[field] = null;
      continue;
    }
    const imei = normalizeImei(input[field]);
    if (imei.error) {
      if (same(input[field], stored[field])) warnings.push(`${label}: valor legado con formato inválido; requiere revisión.`);
      else errors.push(`${label}: ${imei.error}`);
      continue;
    }
    patch[field] = imei.value;
  }
  const finalImei = patch.imei !== undefined ? patch.imei : stored.imei;
  const finalImei2 = patch.imei2 !== undefined ? patch.imei2 : stored.imei2;
  if (finalImei && finalImei2 && finalImei === finalImei2) errors.push('IMEI 1 e IMEI 2 no pueden ser iguales.');

  for (const [field, label] of [['saludBateria', 'Salud de batería'], ['ciclosBateria', 'Ciclos de batería']] as const) {
    if (input[field] === undefined) continue;
    if (checkHidden(field, rules[field], label)) {
      if (input[field] === null) patch[field] = null;
      continue;
    }
    patch[field] = input[field];
  }

  if (input.color !== undefined) {
    const color = String(input.color ?? '').trim();
    if (!color) patch.color = null;
    else if (rules.color.options.length && rules.resolution === 'exact') {
      const match = rules.color.options.find((option) => same(option.value, color) || same(option.label, color) || (option.aliases || []).some((alias) => same(alias, color)));
      if (match) patch.color = match.value;
      else if (same(color, stored.color)) {
        warnings.push('Color: valor legado fuera del catálogo del modelo; requiere revisión.');
      } else errors.push(`Color no disponible para este modelo. Opciones: ${rules.color.options.map((o) => o.label).join(', ')}.`);
    } else patch.color = color.slice(0, 80);
  }

  return { patch, errors, warnings };
}

export function inventoryCompleteness(values: InventoryValues, rules: InventoryFieldRules) {
  const missing: string[] = [];
  if (rules.serial.requiredForComplete && !values.serial) missing.push('serial');
  if (rules.imei.requiredForComplete && !values.imei) missing.push('imei');
  if (rules.imei2.requiredForComplete && !values.imei2) missing.push('imei2');
  if (rules.color.requiredForComplete && !values.color) missing.push('color');
  return { complete: missing.length === 0 && rules.resolution !== 'ambiguous', missing };
}
