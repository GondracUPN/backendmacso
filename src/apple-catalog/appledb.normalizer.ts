// Convierte el JSON público de AppleDB (device/main.json + group/main.json) en modelos
// comerciales con variantes. Función pura: no consulta red ni BD.
//
// Reglas por familia (AppleDB no agrupa igual todas las familias):
//  - iPhone: un dispositivo = un modelo comercial; regiones (US/Global/GSM/CDMA) se fusionan.
//  - iPad: el grupo es el modelo; Wi-Fi / Wi-Fi + Cellular (y "Wi-Fi (1 or 2 TB)") son variantes.
//    Air/Pro con el mismo chip se fusionan y la pantalla pasa a ser selector (11"/13").
//  - Apple Watch: el grupo es la serie; tamaño de caja × conectividad son variantes.
//  - AirPods: el grupo es la edición; izquierdo/derecho/estuche son piezas, no unidades de stock.
//  - Mac: modelo = familia + chip; el tamaño de pantalla es variante/selector.
import type {
  AppleDbColor,
  AppleDbDevice,
  AppleDbGroup,
  AppleDbSource,
  CatalogTipo,
  ClassificationBucket,
  Connectivity,
  NormalizationReport,
  NormalizedModel,
  NormalizedVariant,
} from './apple-catalog.types';

/** Tipos de AppleDB que se conservan del feed (el resto no se descarga a la BD). */
export const APPLEDB_SOURCE_TYPES = [
  'iPhone', 'iPad', 'iPad mini', 'iPad Air', 'iPad Pro', 'Apple Watch', 'AirPods',
  'MacBook Air', 'MacBook Pro', 'MacBook Neo', 'iMac', 'Mac mini', 'Mac Studio', 'Mac Pro',
] as const;

const TYPE_TO_TIPO: Record<string, CatalogTipo | null> = {
  iPhone: 'iphone',
  iPad: 'ipad',
  'iPad mini': 'ipad',
  'iPad Air': 'ipad',
  'iPad Pro': 'ipad',
  'Apple Watch': 'watch',
  AirPods: 'airpods',
  'MacBook Air': 'macbook',
  'MacBook Pro': 'macbook',
  'MacBook Neo': 'macbook',
  iMac: 'imac',
  'Mac mini': 'macmini',
  // Sin `producto.tipo` propio todavía: quedan en el catálogo pero fuera de los selectores.
  'Mac Studio': null,
  'Mac Pro': null,
};

/** Primer lanzamiento incluido en los selectores comerciales; lo anterior queda consultable en el informe. */
export const COMMERCIAL_WINDOW_START = '2019-01-01';

export const asArray = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);

const firstDate = (value: unknown) => asArray(value).sort()[0] || null;
const lastDate = (value: unknown) => asArray(value).sort().slice(-1)[0] || null;
const uniq = <T>(items: T[]) => Array.from(new Set(items));
export const slug = (value: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const ordinal = (name: string) => name.match(/\((\d+)(?:st|nd|rd|th) generation/i)?.[1] || null;
const inchSize = (name: string) => name.match(/(\d+(?:\.\d+)?)-inch/i)?.[1] || null;

const isUnreleased = (device: AppleDbDevice) =>
  Boolean(device.internal) || /unreleased|store display|prototype|developer transition kit/i.test(device.name);

interface Keyed {
  tipo: CatalogTipo;
  modelKey: string;
  title: string;
  detalle: Record<string, string>;
  variantKey: string;
  variantName: string;
  connectivity?: Connectivity | null;
  size?: string | null;
  needsReview?: string[];
  component?: 'left' | 'right' | 'case' | 'other';
}

const IPHONE_REGION = /\s*\((?:US|Global|GSM|CDMA|China|International)[^)]*\)\s*$/i;

function keyIphone(device: AppleDbDevice): Keyed {
  const base = device.name.replace(/^iPhone\s*/i, '').replace(IPHONE_REGION, '').trim();
  const numbered = base.match(/^(\d+)(e)?(?:\s+(Pro Max|Pro|Plus|mini))?$/i);
  const se = base.match(/^SE\s*\((\d+)(?:st|nd|rd|th) generation\)$/i);
  let numero = '';
  let modelo = base;
  const needsReview: string[] = [];
  if (numbered) {
    numero = numbered[1];
    const suffix = numbered[3] || '';
    modelo = numbered[2] ? 'E' : suffix ? (/^mini$/i.test(suffix) ? 'Mini' : suffix.replace(/\b\w/g, (c) => c.toUpperCase())) : 'Normal';
  } else if (se) {
    numero = 'SE';
    modelo = se[1];
  } else {
    // "iPhone Air", "iPhone Duo"...: el número comercial no está en el nombre.
    needsReview.push('detalle.numero');
  }
  return {
    tipo: 'iphone',
    modelKey: `iphone-${slug(numero || 'x')}-${slug(modelo)}`,
    title: `iPhone ${base}`,
    detalle: { numero, modelo },
    variantKey: 'default',
    variantName: `iPhone ${base}`,
    needsReview,
  };
}

function ipadGama(type: string) {
  if (type === 'iPad mini') return 'Mini';
  if (type === 'iPad Air') return 'Air';
  if (type === 'iPad Pro') return 'Pro';
  return 'Normal';
}

function keyIpad(device: AppleDbDevice, group: AppleDbGroup | undefined): Keyed {
  const gama = ipadGama(device.type);
  const connectivity: Connectivity = /cellular/i.test(device.name) ? 'cellular' : 'wifi';
  const size = inchSize(device.name) || (group ? inchSize(group.name) : null);
  const soc = asArray(device.soc)[0] || '';
  const groupName = group?.name || device.name.replace(/\s+Wi-Fi.*$/i, '');
  if (gama === 'Air' || gama === 'Pro') {
    const procesador = soc || 'desconocido';
    return {
      tipo: 'ipad',
      modelKey: `ipad-${slug(gama)}-${slug(procesador)}`,
      title: `iPad ${gama} (${procesador})`,
      detalle: { gama, procesador },
      variantKey: `${connectivity}${size ? `-${size}` : ''}`,
      variantName: device.name,
      connectivity,
      size,
      needsReview: soc ? [] : ['detalle.procesador'],
    };
  }
  const chipInName = groupName.match(/\((A\d+[A-Z]?(?: Pro)?)\)/)?.[1] || null;
  const generacion = ordinal(groupName) || chipInName || '';
  return {
    tipo: 'ipad',
    modelKey: `ipad-${gama === 'Mini' ? 'mini-' : ''}${slug(generacion || groupName)}`,
    title: groupName.replace(/\((\d+)(?:st|nd|rd|th) generation\)/i, '($1.ª generación)'),
    detalle: { gama, generacion },
    variantKey: connectivity,
    variantName: device.name,
    connectivity,
    size,
    needsReview: generacion ? [] : ['detalle.generacion'],
  };
}

function keyWatch(device: AppleDbDevice, group: AppleDbGroup | undefined): Keyed {
  const body = device.name.replace(/^Apple Watch\s*/i, '');
  const line = /^Series/i.test(body) ? 'Series' : /^SE/i.test(body) ? 'SE' : /^Ultra/i.test(body) ? 'Ultra' : '';
  const explicit = body.match(/^(?:Series|SE|Ultra)\s+(\d+)/i)?.[1];
  const generacion = explicit || ordinal(body) || (line === 'SE' || line === 'Ultra' ? '1' : '');
  const size = body.match(/(\d+)\s*mm/i)?.[1] || null;
  const connectivity: Connectivity | null = /GPS\s*\+\s*Cellular/i.test(body) ? 'gps_cellular' : /\bGPS\b/i.test(body) ? 'gps' : null;
  const title = line === 'Ultra' && generacion === '1' ? 'Apple Watch Ultra' : `Apple Watch ${line} ${generacion}`.trim();
  return {
    tipo: 'watch',
    modelKey: `watch-${slug(line || group?.name || body)}-${slug(generacion)}`,
    title,
    detalle: { gama: line, generacion },
    variantKey: `${connectivity || 'x'}-${size || 'x'}`,
    variantName: device.name,
    connectivity,
    size,
    needsReview: line && generacion ? [] : ['detalle.gama'],
  };
}

/** Título comercial corto y estable de una edición de AirPods (compatible con reglas de accesorios). */
export function airpodsShortTitle(groupName: string, siblingNames: string[] = []): string {
  let title = groupName.trim();
  const genUsbc = title.match(/^(.*)\((\d+)(?:st|nd|rd|th) generation, USB-C\)$/i);
  if (genUsbc) title = `${genUsbc[1].trim()} ${genUsbc[2]} USB-C`;
  const gen = title.match(/^(.*)\((\d+)(?:st|nd|rd|th) generation\)$/i);
  if (gen) title = `${gen[1].trim()} ${gen[2]}`;
  title = title
    .replace(/\s+with Active Noise Cancellation$/i, ' con ANC')
    .replace(/\s+with Wireless Charging Case$/i, ' con estuche inalámbrico')
    .replace(/\s+with USB-C$/i, ' USB-C')
    .replace(/\s+/g, ' ')
    .trim();
  const hasAncSibling = siblingNames.some((name) => name.trim() === `${groupName.trim()} with Active Noise Cancellation`);
  if (hasAncSibling) title = `${title} sin ANC`;
  return title;
}

const airpodsGeneration = (title: string) =>
  title.replace(/\s+(con ANC|sin ANC|con estuche inalámbrico|USB-C)$/i, '').trim();

function componentRole(key: string): 'left' | 'right' | 'case' | 'other' {
  if (/-left$/i.test(key)) return 'left';
  if (/-right$/i.test(key)) return 'right';
  if (/case$/i.test(key)) return 'case';
  return 'other';
}

function keyAirpods(device: AppleDbDevice, group: AppleDbGroup | undefined, siblings: string[]): Keyed {
  const groupName = group?.name || device.name;
  const title = airpodsShortTitle(groupName, siblings);
  return {
    tipo: 'airpods',
    modelKey: `airpods-${slug(title)}`,
    title,
    detalle: { modelo: title },
    variantKey: 'default',
    variantName: title,
    component: componentRole(device.key),
  };
}

function keyMac(device: AppleDbDevice, tipo: CatalogTipo): Keyed {
  const soc = asArray(device.soc)[0] || '';
  const size = inchSize(device.name);
  if (tipo === 'macbook') {
    const gama = device.type.replace(/^MacBook\s*/i, '') || 'MacBook';
    return {
      tipo,
      modelKey: `macbook-${slug(gama)}-${slug(soc)}`,
      title: `MacBook ${gama} (${soc})`,
      detalle: { gama, procesador: soc },
      variantKey: size || 'default',
      variantName: device.name,
      size,
    };
  }
  const label = tipo === 'imac' ? 'iMac' : 'Mac mini';
  return {
    tipo,
    modelKey: `${tipo}-${slug(soc)}`,
    title: `${label} (${soc})`,
    detalle: tipo === 'imac' ? { procesador: soc } : { procesador: soc },
    variantKey: size || 'default',
    variantName: device.name,
    size,
  };
}

const ramStorage = (device: AppleDbDevice) => {
  const memory = (device.info || []).find((block) => block?.type === 'Memory');
  if (!memory) return null;
  const clean = (values: unknown) => asArray(values).map((value) => value.replace(/\s+/g, '').toUpperCase());
  return { ram: clean(memory.RAM), storage: clean(memory.Storage) };
};
const screenDiagonal = (device: AppleDbDevice) => {
  const display = (device.info || []).find((block) => block?.type === 'Display');
  return asArray(display?.Screen_Size)[0]?.replace(/["”″]|\s*inch(es)?/gi, '') || null;
};

export interface NormalizeResult {
  models: NormalizedModel[];
  report: NormalizationReport;
}

/** Reduce el feed a los tipos y campos necesarios (lo que se persiste como instantánea). */
export function minimizeAppleDbSource(devices: any[], groups: any[]): Pick<AppleDbSource, 'devices' | 'groups'> {
  const types = new Set<string>(APPLEDB_SOURCE_TYPES);
  return {
    devices: (Array.isArray(devices) ? devices : [])
      .filter((d) => d && typeof d.key === 'string' && typeof d.name === 'string' && types.has(d.type))
      .map((d) => {
        const out: AppleDbDevice = { key: d.key, name: d.name, type: d.type };
        for (const k of ['identifier', 'model', 'soc', 'released', 'discontinued', 'internal'] as const) {
          if (d[k] !== undefined) (out as any)[k] = d[k];
        }
        if (Array.isArray(d.colors)) out.colors = d.colors.map((c: any) => ({ key: c?.key, name: String(c?.name || ''), hex: c?.hex })).filter((c: AppleDbColor) => c.name);
        const info = (Array.isArray(d.info) ? d.info : [])
          .filter((b: any) => b && ['Memory', 'Display'].includes(b.type))
          .map((b: any) => (b.type === 'Memory' ? { type: 'Memory', RAM: b.RAM, Storage: b.Storage } : { type: 'Display', Screen_Size: b.Screen_Size }));
        if (info.length) out.info = info;
        return out;
      })
      .sort((a, b) => a.key.localeCompare(b.key)),
    groups: (Array.isArray(groups) ? groups : [])
      .filter((g) => g && typeof g.key === 'string' && types.has(g.type) && Array.isArray(g.devices))
      .map((g) => ({ key: g.key, name: String(g.name || g.key), type: g.type, devices: g.devices.map(String) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function normalizeAppleDb(source: Pick<AppleDbSource, 'devices' | 'groups'>, windowStart = COMMERCIAL_WINDOW_START): NormalizeResult {
  const byBucket: Record<ClassificationBucket, number> = {
    commercial: 0,
    out_of_window: 0,
    intel_legacy: 0,
    catalog_only: 0,
    component: 0,
    unreleased_or_internal: 0,
    unclassified: 0,
  };
  const unclassified: NormalizationReport['unclassified'] = [];
  const groupOf = new Map<string, AppleDbGroup>();
  const allGroupsOf = new Map<string, AppleDbGroup[]>();
  for (const group of source.groups || []) {
    if (/unreleased|store display/i.test(group.name)) continue;
    for (const key of group.devices || []) {
      if (!groupOf.has(key)) groupOf.set(key, group);
      allGroupsOf.set(key, [...(allGroupsOf.get(key) || []), group]);
    }
  }
  const airpodsGroupNames = (source.groups || []).filter((g) => g.type === 'AirPods').map((g) => g.name);

  const models = new Map<string, NormalizedModel>();
  const sharedCases: Array<{ device: AppleDbDevice; group: AppleDbGroup }> = [];
  for (const device of source.devices || []) {
    if (!(device.type in TYPE_TO_TIPO)) {
      byBucket.unclassified++;
      unclassified.push({ key: device.key, name: device.name, type: device.type });
      continue;
    }
    if (isUnreleased(device)) { byBucket.unreleased_or_internal++; continue; }
    const tipo = TYPE_TO_TIPO[device.type];
    if (!tipo) { byBucket.catalog_only++; continue; }
    const released = firstDate(device.released);
    if (!released || released < windowStart) { byBucket.out_of_window++; continue; }
    const group = groupOf.get(device.key);
    if ((tipo === 'macbook' || tipo === 'imac' || tipo === 'macmini') && !asArray(device.soc).length) {
      byBucket.intel_legacy++;
      continue;
    }

    // Un estuche AirPods puede pertenecer a varias ediciones (p. ej. el estuche inalámbrico de 1.ª/2.ª gen.).
    if (tipo === 'airpods' && componentRole(device.key) === 'case' && (allGroupsOf.get(device.key) || []).length > 1) {
      byBucket.component++;
      for (const caseGroup of allGroupsOf.get(device.key) || []) sharedCases.push({ device, group: caseGroup });
      continue;
    }

    let keyed: Keyed;
    if (tipo === 'iphone') keyed = keyIphone(device);
    else if (tipo === 'ipad') keyed = keyIpad(device, group);
    else if (tipo === 'watch') keyed = keyWatch(device, group);
    else if (tipo === 'airpods') keyed = keyAirpods(device, group, airpodsGroupNames);
    else keyed = keyMac(device, tipo);

    if (keyed.component && keyed.component !== 'other') byBucket.component++;
    else byBucket.commercial++;

    let model = models.get(keyed.modelKey);
    if (!model) {
      model = {
        id: keyed.modelKey,
        tipo: keyed.tipo,
        appleDbType: device.type,
        title: keyed.title,
        detalle: keyed.detalle,
        chip: asArray(device.soc)[0] || null,
        released,
        discontinued: lastDate(device.discontinued),
        appleDbGroups: [],
        variants: [],
        memory: null,
        displayDiagonal: null,
        components: tipo === 'airpods' ? [] : undefined,
        needsReview: [],
      };
      models.set(keyed.modelKey, model);
    }
    if (released < (model.released || '9999')) model.released = released;
    if (group && !model.appleDbGroups.includes(group.key)) model.appleDbGroups.push(group.key);
    model.needsReview = uniq([...model.needsReview, ...(keyed.needsReview || [])]);
    const chip = asArray(device.soc)[0];
    if (chip && model.chip && chip !== model.chip && keyed.tipo === 'ipad') {
      model.needsReview = uniq([...model.needsReview, 'chip']);
    }
    if (tipo === 'airpods' && keyed.component && keyed.component !== 'other') {
      model.components!.push({ key: device.key, name: device.name, role: keyed.component });
      // Las piezas aportan identificadores al conjunto, pero no colores ni variantes de stock.
      const variant = ensureVariant(model, keyed);
      variant.appleDbKeys.push(device.key);
      variant.hardwareModels = uniq([...variant.hardwareModels, ...asArray(device.model)]);
      if (!variant.colors.length && device.colors?.length && keyed.component !== 'case') variant.colors = [...device.colors];
      continue;
    }
    const variant = ensureVariant(model, keyed);
    variant.appleDbKeys.push(device.key);
    variant.hardwareModels = uniq([...variant.hardwareModels, ...asArray(device.model)]);
    variant.identifiers = uniq([...variant.identifiers, ...asArray(device.identifier)]);
    for (const color of device.colors || []) {
      if (!variant.colors.some((c) => c.name === color.name)) variant.colors.push(color);
    }
    const memory = ramStorage(device);
    if (memory) {
      model.memory = {
        ram: uniq([...(model.memory?.ram || []), ...memory.ram]),
        storage: uniq([...(model.memory?.storage || []), ...memory.storage]),
      };
    }
    model.displayDiagonal = model.displayDiagonal || screenDiagonal(device);
  }

  for (const { device, group } of sharedCases) {
    const model = models.get(keyAirpods(device, group, airpodsGroupNames).modelKey);
    if (!model) continue;
    model.components!.push({ key: device.key, name: device.name, role: 'case' });
    const variant = model.variants[0];
    if (variant) {
      variant.appleDbKeys.push(device.key);
      variant.hardwareModels = uniq([...variant.hardwareModels, ...asArray(device.model)]);
    }
  }
  for (const [key, model] of models) {
    // Una edición sin auriculares dentro de la ventana comercial no es un conjunto vendible.
    if (model.tipo === 'airpods' && model.components && !model.components.some((c) => c.role !== 'case') && !model.variants.some((v) => v.identifiers.length)) {
      models.delete(key);
      byBucket.out_of_window++;
    }
  }
  for (const model of models.values()) {
    if (model.tipo === 'airpods') model.generation = airpodsGeneration(model.title);
    model.variants.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  }

  return {
    models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })),
    report: { totalDevices: (source.devices || []).length, byBucket, unclassified },
  };
}

function ensureVariant(model: NormalizedModel, keyed: Keyed): NormalizedVariant {
  let variant = model.variants.find((item) => item.id === keyed.variantKey);
  if (!variant) {
    variant = {
      id: keyed.variantKey,
      name: keyed.variantName.replace(IPHONE_REGION, ''),
      appleDbKeys: [],
      hardwareModels: [],
      identifiers: [],
      connectivity: keyed.connectivity ?? null,
      size: keyed.size ?? null,
      colors: [],
    };
    model.variants.push(variant);
  }
  return variant;
}
