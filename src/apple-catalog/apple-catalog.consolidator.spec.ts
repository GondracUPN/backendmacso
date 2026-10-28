import { consolidateCatalog, coverageReport, hashJson } from './apple-catalog.consolidator';
import { normalizeAppleDb } from './appledb.normalizer';
import { APPLEDB_BASELINE } from './data/appledb-baseline.data';
import { APPLE_SPECS_DATASET } from './data/apple-specs.dataset';
import type { AppleDbSource, ConsolidatedCatalog } from './apple-catalog.types';

// Fixture congelado: subconjunto real de AppleDB (MIT) generado por tools/build-appledb-baseline.cjs.
const build = (appleDb: AppleDbSource = APPLEDB_BASELINE, extra: Partial<Parameters<typeof consolidateCatalog>[0]> = {}) =>
  consolidateCatalog({ appleDb, appleDbHash: hashJson(appleDb.devices), dataset: APPLE_SPECS_DATASET, generatedAt: 'fixed', ...extra });
const model = (catalog: ConsolidatedCatalog, id: string) => {
  const found = catalog.models.find((m) => m.id === id);
  if (!found) throw new Error(`Modelo ${id} ausente`);
  return found;
};
const options = (catalog: ConsolidatedCatalog, id: string, field: string) =>
  model(catalog, id).selectors.find((s) => s.field === field)?.options.map((o) => o.value);

describe('normalizeAppleDb (reglas por familia)', () => {
  const { models, report } = normalizeAppleDb(APPLEDB_BASELINE);
  const byId = new Map(models.map((m) => [m.id, m]));

  it('agrupa variantes Wi-Fi/Cellular de iPad y colapsa "Wi-Fi (1 or 2 TB)" en la misma variante', () => {
    const pro = byId.get('ipad-pro-m1')!;
    expect(pro.variants.map((v) => v.id).sort()).toEqual(['cellular-11', 'cellular-12.9', 'wifi-11', 'wifi-12.9']);
    expect(pro.variants.find((v) => v.id === 'wifi-11')!.appleDbKeys).toEqual(expect.arrayContaining(['iPad13,4', 'iPad13,5']));
  });

  it('fusiona regiones de iPhone sin duplicar el modelo comercial', () => {
    const max = byId.get('iphone-18-pro-max')!;
    expect(max.variants).toHaveLength(1);
    expect(max.variants[0].appleDbKeys.sort()).toEqual(['iPhone19,3', 'iPhone19,7']);
  });

  it('trata izquierdo/derecho/estuche de AirPods como piezas de un conjunto, no como unidades', () => {
    const anc = byId.get('airpods-airpods-4-con-anc')!;
    expect(anc.variants).toHaveLength(1);
    expect(anc.components!.map((c) => c.role).sort()).toEqual(['case', 'left', 'right']);
    expect(models.filter((m) => m.tipo === 'airpods' && /left|right|case/i.test(m.title))).toHaveLength(0);
  });

  it('clasifica explícitamente lo no comercial y cuenta tipos desconocidos', () => {
    const extended = normalizeAppleDb({
      devices: [...APPLEDB_BASELINE.devices, { key: 'Vision9,9', name: 'Apple Vision Pro 9', type: 'Vision', released: '2026-01-01' }],
      groups: APPLEDB_BASELINE.groups,
    });
    expect(extended.report.unclassified).toEqual([{ key: 'Vision9,9', name: 'Apple Vision Pro 9', type: 'Vision' }]);
    expect(report.byBucket.unreleased_or_internal).toBeGreaterThan(0);
    expect(report.byBucket.catalog_only).toBeGreaterThan(0); // Mac Studio / Mac Pro sin tipo de producto
  });
});

describe('consolidateCatalog', () => {
  const catalog = build();

  it('Mini 5 = 7,9", Mini 6 = 8,3" y Air M1 con pantalla única; la generación no es diagonal', () => {
    expect(options(catalog, 'ipad-mini-5', 'tamano')).toEqual(['7.9']);
    expect(options(catalog, 'ipad-mini-6', 'tamano')).toEqual(['8.3']);
    expect(options(catalog, 'ipad-air-m1', 'tamano')).toEqual(['10.9']);
    const a16 = model(catalog, 'ipad-a16');
    expect(a16.detalle).toEqual({ gama: 'Normal', generacion: '11' });
    expect(a16.selectors.find((s) => s.field === 'tamano')!.options[0]).toMatchObject({ value: '11', diagonal: '10.86' });
  });

  it('aplica la matriz de selectores comerciales por familia', () => {
    const fields = (id: string) => model(catalog, id).selectors.map((s) => s.field);
    expect(fields('iphone-16-pro')).toEqual(['almacenamiento']);
    expect(fields('ipad-air-m2')).toEqual(['tamano', 'almacenamiento', 'conexion']);
    expect(fields('watch-series-10')).toEqual(['tamano', 'conexion']);
    expect(fields('macbook-pro-m4-pro')).toEqual(['tamano', 'ram', 'almacenamiento']);
    expect(fields('imac-m4')).toEqual(['tamano', 'ram', 'almacenamiento']);
    expect(fields('macmini-m4')).toEqual(['ram', 'almacenamiento']);
    expect(fields('airpods-airpods-4-con-anc')).toEqual([]);
  });

  it('Watch usa tamaño de caja en mm y filtra GPS/GPS + Cellular por modelo', () => {
    const sizeSel = model(catalog, 'watch-series-10').selectors.find((s) => s.field === 'tamano')!;
    expect(sizeSel).toMatchObject({ unit: 'mm', label: 'Tamaño de caja' });
    expect(sizeSel.options.map((o) => o.value)).toEqual(['42 mm', '46 mm']);
    expect(options(catalog, 'watch-ultra-3', 'tamano')).toEqual(['49 mm']);
    expect(options(catalog, 'watch-ultra-3', 'conexion')).toEqual(['GPS + Cel']);
  });

  it('asocia colores al modelo concreto: Ultra 3, Air M5 vs Pro M5 y Pro M1', () => {
    expect(model(catalog, 'watch-ultra-3').colors.map((c) => c.label)).toEqual(['Titanio natural', 'Titanio negro']);
    expect(model(catalog, 'macbook-air-m5').colors.map((c) => c.label).sort()).toEqual(['Azul cielo', 'Blanco estrella', 'Medianoche', 'Plata']);
    expect(model(catalog, 'macbook-pro-m5').colors.map((c) => c.label).sort()).toEqual(['Negro espacial', 'Plata']);
    expect(model(catalog, 'macbook-pro-m1').colors.map((c) => c.label).sort()).toEqual(['Gris espacial', 'Plata']);
  });

  it('AirPods 4 permite elegir ANC; AirPods 5 no ofrece "sin ANC" (ANC en ambos modelos)', () => {
    expect(model(catalog, 'airpods-airpods-4-con-anc').airpods).toMatchObject({ generation: 'AirPods 4', anc: true, ancSelectable: true });
    expect(model(catalog, 'airpods-airpods-4-sin-anc').airpods).toMatchObject({ generation: 'AirPods 4', anc: false, ancSelectable: true });
    const five = catalog.models.filter((m) => m.airpods?.generation === 'AirPods 5');
    expect(five.map((m) => m.title).sort()).toEqual(['AirPods 5', 'AirPods 5 con estuche inalámbrico']);
    expect(five.every((m) => m.airpods!.anc === true && !m.airpods!.ancSelectable)).toBe(true);
    expect(model(catalog, 'airpods-airpods-4-con-anc').capabilities.battery).toMatchObject({ health: 'none', cycles: 'none' });
  });

  it('capacidades de identificación por variante: Mac sin IMEI, iPhone 2, iPad/Watch según conectividad', () => {
    expect(model(catalog, 'macbook-air-m2').capabilities.identifiers.imeiCount).toBe(0);
    expect(model(catalog, 'iphone-16-pro').capabilities.identifiers).toMatchObject({ imeiCount: 2, imeiStatus: 'confirmed' });
    const ipad = model(catalog, 'ipad-mini-6');
    expect(ipad.variants.find((v) => v.connectivity === 'wifi')!.capabilities.identifiers.imeiCount).toBe(0);
    expect(ipad.variants.find((v) => v.connectivity === 'cellular')!.capabilities.identifiers.imeiCount).toBe(1);
    const watch = model(catalog, 'watch-se-3');
    expect(watch.variants.find((v) => v.connectivity === 'gps')!.capabilities.identifiers.imeiCount).toBe(0);
    expect(watch.variants.find((v) => v.connectivity === 'gps_cellular')!.capabilities.identifiers.imeiCount).toBe(1);
  });

  it('batería: sobremesa sin métricas, Watch sin ciclos, iPad nativo solo en modelos documentados', () => {
    expect(model(catalog, 'imac-m4').capabilities.battery).toEqual({ hasBattery: false, health: 'none', cycles: 'none' });
    expect(model(catalog, 'macmini-m4').capabilities.battery.health).toBe('none');
    expect(model(catalog, 'watch-ultra-3').capabilities.battery).toMatchObject({ health: 'native', cycles: 'none' });
    expect(model(catalog, 'ipad-air-m2').capabilities.battery.health).toBe('native');
    expect(model(catalog, 'ipad-mini-6').capabilities.battery.health).toBe('manual');
  });

  it('no expone RAM como selector de iPhone/iPad/Watch aunque AppleDB la tenga', () => {
    for (const m of catalog.models.filter((x) => ['iphone', 'ipad', 'watch'].includes(x.tipo))) {
      expect(m.selectors.some((s) => s.field === 'ram')).toBe(false);
    }
  });

  it('un modelo nuevo de AppleDB aparece sin cambiar código y sus huecos quedan desconocidos', () => {
    const appleDb: AppleDbSource = {
      ...APPLEDB_BASELINE,
      devices: [...APPLEDB_BASELINE.devices, { key: 'iPhone99,1', name: 'iPhone 30 Pro', type: 'iPhone', released: '2036-09-20', model: ['A9999'], identifier: ['iPhone99,1'], colors: [{ name: 'Silver', hex: 'EEEEEE' }] }],
    };
    const next = build(appleDb);
    const added = model(next, 'iphone-30-pro');
    expect(added.detalle).toEqual({ numero: '30', modelo: 'Pro' });
    expect(added.selectors[0]).toMatchObject({ field: 'almacenamiento', status: 'unknown', options: [] });
    expect(added.colors.map((c) => c.label)).toEqual(['Plata']);
    expect(coverageReport(next, { listedOnly: false }).find((r) => r.tipo === 'iphone')!.gaps).toEqual(expect.arrayContaining([{ modelId: 'iphone-30-pro', field: 'almacenamiento' }]));
  });

  it('una anulación administrativa prevalece y queda con procedencia; el dataset no la pisa', () => {
    const withOverride = build(APPLEDB_BASELINE, {
      overrides: [{ id: 1, modelId: 'iphone-17-e', field: 'selectors.almacenamiento', value: ['256', '512'], reason: 'Ficha oficial revisada', createdAt: '2026-10-22' }],
    });
    const sel = model(withOverride, 'iphone-17-e').selectors[0];
    expect(sel.options.map((o) => o.value)).toEqual(['256', '512']);
    expect(sel.provenance!.source).toBe('override');
    expect(withOverride.version).not.toBe(catalog.version);
  });

  it('es determinista: mismas entradas, misma versión', () => {
    expect(build().version).toBe(catalog.version);
  });

  it('declara los conflictos entre fuentes en vez de resolverlos en silencio', () => {
    expect(catalog.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'macbook-air-m5', field: 'hardwareModels' }),
    ]));
  });

  it('conserva opciones administrativas previas (/catalog/product-options) con su procedencia', () => {
    const withLegacy = build(APPLEDB_BASELINE, {
      legacyOptions: [{ id: 7, productType: 'iphone', family: '17', value: '17', metadata: { models: ['Pro'], storages: ['2TB'] } }],
    });
    expect(options(withLegacy, 'iphone-17-pro', 'almacenamiento')).toContain('2TB');
  });
});

describe('modelos manuales y anulaciones huérfanas', () => {
  it('una entrada del dataset con tipo, título y detalle publica un modelo aún ausente en AppleDB', () => {
    const manual = {
      id: 'watch-series-13', tipo: 'watch' as const, title: 'Apple Watch Series 13', detalle: { gama: 'Series', generacion: '13' },
      caseSizesMm: { value: ['42', '46'], provenance: { source: 'curated' as const } },
      connectivity: { value: ['gps', 'gps_cellular'] as any, provenance: { source: 'curated' as const } },
    };
    const catalog = build(APPLEDB_BASELINE, { dataset: { ...APPLE_SPECS_DATASET, models: [...APPLE_SPECS_DATASET.models, manual] } });
    const m = model(catalog, 'watch-series-13');
    expect(m.needsReview).toContain('manual_dataset_model');
    expect(m.selectors.find((s) => s.field === 'tamano')!.options.map((o) => o.value)).toEqual(['42 mm', '46 mm']);
    expect(m.variants.find((v) => v.connectivity === 'gps_cellular')!.capabilities.identifiers.imeiCount).toBe(1);
  });
  it('reporta una anulación cuyo modelo ya no existe en lugar de ignorarla', () => {
    const catalog = build(APPLEDB_BASELINE, { overrides: [{ id: 9, modelId: 'iphone-renombrado', field: 'title', value: 'X', reason: 'prueba de huérfana' }] });
    expect(catalog.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: 'iphone-renombrado', field: 'override' })]));
  });
});
