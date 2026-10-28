import { consolidateCatalog, hashJson } from './apple-catalog.consolidator';
import { resolveProductModel } from './apple-catalog.resolver';
import { APPLEDB_BASELINE } from './data/appledb-baseline.data';
import { APPLE_SPECS_DATASET } from './data/apple-specs.dataset';
import {
  inventoryCompleteness,
  inventoryFieldRules,
  normalizeImei,
  normalizeSerial,
  validateInventoryValues,
} from './device-capabilities';

const catalog = consolidateCatalog({ appleDb: APPLEDB_BASELINE, appleDbHash: hashJson(APPLEDB_BASELINE.devices), dataset: APPLE_SPECS_DATASET });
const rulesFor = (tipo: string, detalle: Record<string, string>, estado = 'usado') => {
  const r = resolveProductModel(catalog, tipo, detalle);
  return inventoryFieldRules({ tipo, estado, model: r.model, variant: r.variant, connectivity: r.variant ? undefined : null, resolution: r.status });
};
const VALID_IMEI = '490154203237518';
const VALID_IMEI_2 = '356938035643809';

describe('identificadores', () => {
  it('IMEI: 15 dígitos con Luhn, conserva ceros iniciales y rechaza checksum inválido', () => {
    expect(normalizeImei('49-015420-323751-8')).toEqual({ value: VALID_IMEI });
    expect(normalizeImei('012345678901237').value).toBe('012345678901237');
    expect(normalizeImei('490154203237519').error).toMatch(/Luhn/);
    expect(normalizeImei('12345').error).toMatch(/15 dígitos/);
  });
  it('serial sin patrón rígido: admite 10 y 12 caracteres, normaliza mayúsculas', () => {
    expect(normalizeSerial(' c02xl0ghjgh5 ').value).toBe('C02XL0GHJGH5');
    expect(normalizeSerial('K7GJ2X9P4Q').value).toBe('K7GJ2X9P4Q');
    expect(normalizeSerial('ab#12').error).toBeTruthy();
  });
});

describe('reglas de ficha por modelo', () => {
  it('Mac: serial sí, IMEI no; iPhone: IMEI 1 y 2 requeridos para ficha completa', () => {
    const mac = rulesFor('macbook', { gama: 'Air', procesador: 'M2' });
    expect(mac.imei.visible).toBe(false);
    expect(mac.serial).toMatchObject({ visible: true, requiredForComplete: true });
    const iphone = rulesFor('iphone', { numero: '16', modelo: 'Pro' });
    expect(iphone.imei).toMatchObject({ visible: true, requiredForComplete: true });
    expect(iphone.imei2).toMatchObject({ visible: true, requiredForComplete: true });
  });
  it('iPad y Watch con/sin celular', () => {
    expect(rulesFor('ipad', { gama: 'Mini', generacion: '6', conexion: 'Wifi' }).imei.visible).toBe(false);
    expect(rulesFor('ipad', { gama: 'Mini', generacion: '6', conexion: 'Wifi + Cel' }).imei).toMatchObject({ visible: true, requiredForComplete: true });
    expect(rulesFor('ipad', { gama: 'Mini', generacion: '6', conexion: 'Wifi + Cel' }).imei2.visible).toBe(false);
    expect(rulesFor('watch', { gama: 'SE', generacion: '3', tamano: '40 mm', conexion: 'GPS' }).imei.visible).toBe(false);
    expect(rulesFor('watch', { gama: 'Ultra', generacion: '3', tamano: '49 mm', conexion: 'GPS + Cel' }).imei.visible).toBe(true);
  });
  it('batería: sobremesa y AirPods sin salud/ciclos; Watch salud sin ciclos; sellado sin inspección', () => {
    expect(rulesFor('imac', { procesador: 'M4' }).saludBateria.visible).toBe(false);
    expect(rulesFor('macmini', { procesador: 'M4' }).ciclosBateria.visible).toBe(false);
    expect(rulesFor('airpods', { modelo: 'AirPods Pro 3' }).saludBateria.visible).toBe(false);
    const watch = rulesFor('watch', { gama: 'Series', generacion: '10', tamano: '42 mm', conexion: 'GPS' });
    expect([watch.saludBateria.visible, watch.ciclosBateria.visible]).toEqual([true, false]);
    expect(rulesFor('macbook', { gama: 'Air', procesador: 'M2' }, 'nuevo').saludBateria.visible).toBe(false);
    expect(rulesFor('ipad', { gama: 'Mini', generacion: '6', conexion: 'Wifi' }).saludBateria.source).toBe('manual');
  });
  it('colores del modelo como opciones (Ultra 3 solo dos acabados)', () => {
    expect(rulesFor('watch', { gama: 'Ultra', generacion: '3', tamano: '49 mm', conexion: 'GPS + Cel' }).color.options.map((o) => o.label))
      .toEqual(['Titanium - Natural', 'Titanium - Black']);
  });
});

describe('validateInventoryValues', () => {
  const ipadWifi = rulesFor('ipad', { gama: 'Mini', generacion: '6', conexion: 'Wifi' });
  const iphone = rulesFor('iphone', { numero: '15', modelo: 'Pro' });

  it('rechaza un IMEI nuevo en un modelo Wi-Fi aunque el cliente esté manipulado', () => {
    expect(validateInventoryValues({ imei: VALID_IMEI }, {}, ipadWifi).errors).toEqual(['IMEI 1 no aplica a este modelo.']);
  });
  it('conserva un IMEI legado sin cambios y lo marca para revisión (no lo borra)', () => {
    const result = validateInventoryValues({ imei: VALID_IMEI }, { imei: VALID_IMEI }, ipadWifi);
    expect(result.errors).toEqual([]);
    expect(result.patch.imei).toBeUndefined();
    expect(result.warnings[0]).toMatch(/legado/);
  });
  it('normaliza IMEI válidos, rechaza duplicado dentro de la unidad y checksum inválido', () => {
    expect(validateInventoryValues({ imei: VALID_IMEI, imei2: VALID_IMEI_2 }, {}, iphone).patch).toEqual({ imei: VALID_IMEI, imei2: VALID_IMEI_2 });
    expect(validateInventoryValues({ imei: VALID_IMEI, imei2: VALID_IMEI }, {}, iphone).errors).toContain('IMEI 1 e IMEI 2 no pueden ser iguales.');
    expect(validateInventoryValues({ imei: '490154203237519' }, {}, iphone).errors[0]).toMatch(/Luhn/);
  });
  it('rechaza salud de batería en sobremesa y color fuera del catálogo del modelo', () => {
    const imac = rulesFor('imac', { procesador: 'M4' });
    expect(validateInventoryValues({ saludBateria: 90 }, {}, imac).errors).toEqual(['Salud de batería no aplica a este modelo.']);
    const ultra = rulesFor('watch', { gama: 'Ultra', generacion: '3', tamano: '49 mm', conexion: 'GPS + Cel' });
    expect(validateInventoryValues({ color: 'Oro rosa' }, {}, ultra).errors[0]).toMatch(/Color no disponible/);
    expect(validateInventoryValues({ color: 'titanio negro' }, {}, ultra).patch.color).toBe('Titanium - Black');
  });
  it('borrador permitido; ficha completa exige identificadores aplicables', () => {
    expect(inventoryCompleteness({ serial: 'ABCDEFGHJK', imei: VALID_IMEI }, iphone)).toEqual({ complete: false, missing: ['imei2', 'color'] });
    expect(inventoryCompleteness({ serial: 'ABCDEFGHJK' }, ipadWifi).missing).not.toContain('imei');
  });
});

describe('equipos fuera del catálogo y alias de color', () => {
  it('"otro": capacidades desconocidas (opcionales, nunca requeridas) y el IMEI igualmente se valida', () => {
    const otro = inventoryFieldRules({ tipo: 'otro', estado: 'usado', resolution: 'not_catalog' });
    expect(otro.imei).toEqual({ visible: true, requiredForComplete: false });
    expect(otro.imeiStatus).toBe('unknown');
    expect(otro.saludBateria.visible).toBe(true);
    expect(validateInventoryValues({ imei: VALID_IMEI }, {}, otro).patch.imei).toBe(VALID_IMEI);
    expect(validateInventoryValues({ imei: '123' }, {}, otro).errors[0]).toMatch(/15 dígitos/);
    expect(inventoryCompleteness({}, otro).complete).toBe(true);
    expect(inventoryFieldRules({ tipo: 'accesorios', resolution: 'not_catalog' }).imei.visible).toBe(false);
  });
  it('guarda el acabado en inglés y acepta traducciones previas como alias', () => {
    const air = rulesFor('macbook', { gama: 'Air', procesador: 'M5', tamano: '13' });
    expect(validateInventoryValues({ color: 'Midnight' }, {}, air).patch.color).toBe('Midnight');
    expect(validateInventoryValues({ color: 'Medianoche' }, { color: 'Medianoche' }, air).patch.color).toBe('Midnight');
    expect(air.color.options.find((option) => option.value === 'Midnight')).toMatchObject({ label: 'Midnight', aliases: ['Medianoche'] });
  });
});
