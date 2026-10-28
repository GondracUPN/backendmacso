import { consolidateCatalog, hashJson } from './apple-catalog.consolidator';
import { identifyFromText, resolveProductModel } from './apple-catalog.resolver';
import { APPLEDB_BASELINE } from './data/appledb-baseline.data';
import { APPLE_SPECS_DATASET } from './data/apple-specs.dataset';

const catalog = consolidateCatalog({ appleDb: APPLEDB_BASELINE, appleDbHash: hashJson(APPLEDB_BASELINE.devices), dataset: APPLE_SPECS_DATASET });

describe('identifyFromText', () => {
  it('A2338 compartido devuelve candidatos y no rellena RAM/SSD mínimos', () => {
    const result = identifyFromText(catalog, 'MacBook Pro 13 A2338');
    expect(result.status).toBe('ambiguous');
    expect(result.candidates.map((c) => c.modelId).sort()).toEqual(['macbook-pro-m1', 'macbook-pro-m2']);
    for (const candidate of result.candidates) {
      expect(candidate.detalle.ram).toBeUndefined();
      expect(candidate.detalle.almacenamiento).toBeUndefined();
    }
  });

  it('identificador desconocido no inventa resultados', () => {
    expect(identifyFromText(catalog, 'Apple A0000')).toMatchObject({ status: 'unknown', candidates: [] });
  });

  it('un código de pedido con configuración documentada sí completa RAM/SSD', () => {
    const result = identifyFromText(catalog, 'Apple Laptop MHFC4LL/A');
    expect(result.status).toBe('exact');
    expect(result.candidates[0].detalle).toMatchObject({ gama: 'Neo', procesador: 'A18 Pro', tamano: '13', ram: '8', almacenamiento: '512' });
  });

  it('A3448 (Air M5) en conflicto entre fuentes identifica el modelo sin fijar el tamaño', () => {
    const result = identifyFromText(catalog, 'MacBook Air A3448');
    expect(result.status).toBe('exact');
    expect(result.candidates[0]).toMatchObject({ modelId: 'macbook-air-m5', variantId: null });
    expect(result.candidates[0].detalle.tamano).toBeUndefined();
    expect(result.candidates[0].conflicts.length).toBeGreaterThan(0);
  });

  it('Watch: el número A determina caja y conectividad según la fuente oficial', () => {
    const result = identifyFromText(catalog, 'Apple Watch A2999');
    expect(result.candidates[0]).toMatchObject({ modelId: 'watch-series-10', detalle: expect.objectContaining({ tamano: '46 mm', conexion: 'GPS' }) });
  });
});

describe('resolveProductModel', () => {
  it('generación 11 de iPad resuelve el iPad (A16), no una pantalla de 11"', () => {
    const r = resolveProductModel(catalog, 'ipad', { gama: 'Normal', generacion: '11', tamano: '11', almacenamiento: '128', conexion: 'Wifi' });
    expect(r).toMatchObject({ status: 'exact', invalid: [] });
    expect(r.model!.id).toBe('ipad-a16');
    expect(r.variant!.capabilities.identifiers.imeiCount).toBe(0);
  });

  it('Productos e Inventario resuelven el mismo modelo con valores legados (AirPods 4 ANC, Watch Normal)', () => {
    expect(resolveProductModel(catalog, 'airpods', { modelo: 'AirPods 4 ANC' }).model!.id).toBe('airpods-airpods-4-con-anc');
    expect(resolveProductModel(catalog, 'airpods', { modelo: 'AirPods 4' }).model!.id).toBe('airpods-airpods-4-sin-anc');
    const watch = resolveProductModel(catalog, 'watch', { gama: 'Normal', generacion: '9', tamano: '45 mm', conexion: 'GPS + Cel' });
    expect(watch.model!.id).toBe('watch-series-9');
    expect(watch.variant!.capabilities.identifiers.imeiCount).toBe(1);
  });

  it('señala selecciones inválidas y combinaciones RAM/SSD no vendidas', () => {
    const r = resolveProductModel(catalog, 'macbook', { gama: 'Air', procesador: 'M5', tamano: '13', ram: '8', almacenamiento: '256' });
    expect(r.invalid.map((i) => i.field)).toEqual(expect.arrayContaining(['ram', 'almacenamiento']));
    const ok = resolveProductModel(catalog, 'macbook', { gama: 'Air', procesador: 'M5', tamano: '15', ram: '24', almacenamiento: '1TB' });
    expect(ok.invalid).toEqual([]);
  });

  it('modelo desconocido no se asigna a la fuerza', () => {
    expect(resolveProductModel(catalog, 'iphone', { numero: '99', modelo: 'Pro' })).toMatchObject({ status: 'unknown', model: null });
  });
});
