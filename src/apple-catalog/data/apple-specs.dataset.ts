// Dataset complementario propio (gratuito) de especificaciones comerciales.
// Completa los huecos de AppleDB: capacidades, pantallas, combinaciones RAM/SSD, ANC, IMEI y batería.
//
// Niveles de procedencia:
//  - apple_official: contrastado el 2026-10-22 con la ficha oficial enlazada (sin copiar textos ni imágenes).
//  - curated: conocimiento del equipo pendiente de contraste con la ficha oficial; se publica marcado así.
//  - project_rules: portado de las reglas previas de formularios del proyecto (no verificado de forma oficial).
// Publicar una versión nueva = editar este archivo (incrementar `version`) o importar un JSON con el mismo
// esquema desde POST /apple-catalog/dataset/publish. Nunca cambia componentes React.
import type { DatasetFact, DatasetModelEntry, MacCombo, Provenance, SpecsDataset } from '../apple-catalog.types';

const VERIFIED = '2026-10-22';
const official = (url: string, note?: string): Provenance => ({ source: 'apple_official', url, verifiedAt: VERIFIED, ...(note ? { note } : {}) });
const curated = (note?: string): Provenance => ({
  source: 'curated',
  url: 'https://support.apple.com/specs',
  note: note || 'Pendiente de contraste con la ficha técnica oficial.',
});
const projectRules = (note?: string): Provenance => ({
  source: 'project_rules',
  note: note || 'Portado de frontend-tailwind/src/components/formParts y utils/appleModelLookup.js.',
});
const fact = <T>(value: T, provenance: Provenance): DatasetFact<T> => ({ value, provenance });

const URL = {
  ipadMini5: 'https://support.apple.com/en-bn/111904',
  ipadMini6: 'https://support.apple.com/en-lamr/111886',
  ipadBattery: 'https://support.apple.com/en-sa/117759',
  serialImei: 'https://support.apple.com/es-es/108037',
  watchIdentify: 'https://support.apple.com/en-us/108056',
  ultra3: 'https://support.apple.com/en-mide/125095',
  mbpM1: 'https://support.apple.com/es-co/111893',
  mbpIdentify: 'https://support.apple.com/en-ca/108052',
  airM5: 'https://www.apple.com/es/newsroom/2026/03/apple-introduces-the-new-macbook-air-with-m5/',
  airpods5: 'https://www.apple.com/shop/buy-airpods/airpods-5',
  airpodsCompare: 'https://www.apple.com/airpods/compare/',
  iphoneCompare: 'https://www.apple.com/iphone/compare/',
};

// ---------------- iPhone ----------------
const S = (...values: string[]) => values;
const iphone = (id: string, storages: string[] | null, provenance: Provenance, extra: Partial<DatasetModelEntry> = {}): DatasetModelEntry => ({
  id,
  ...(storages ? { storages: fact(storages, provenance) } : {}),
  // iPhone XS/XR y posteriores registran IMEI e IMEI2 (eSIM). EID no es IMEI 2.
  imeiCount: fact<2>(2, curated('iPhone XS/XR y posteriores muestran IMEI e IMEI2 en Ajustes > General > Información.')),
  ...extra,
});
const iphoneBattery = (cyclesNative: boolean) => fact(
  { hasBattery: true, health: 'native' as const, cycles: cyclesNative ? 'native' as const : 'manual' as const },
  curated(cyclesNative
    ? 'iPhone 15 y posteriores muestran el contador de ciclos en Ajustes > Batería.'
    : 'Salud nativa; los ciclos solo por diagnóstico manual.'),
);

const IPHONES: DatasetModelEntry[] = [
  iphone('iphone-11-normal', S('64', '128', '256'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-11-pro', S('64', '256', '512'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-11-pro-max', S('64', '256', '512'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-12-mini', S('64', '128', '256'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-12-normal', S('64', '128', '256'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-12-pro', S('128', '256', '512'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-12-pro-max', S('128', '256', '512'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-13-mini', S('128', '256', '512'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-13-normal', S('128', '256', '512'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-13-pro', S('128', '256', '512', '1TB'), curated('Las reglas previas omitían 1TB.'), { battery: iphoneBattery(false) }),
  iphone('iphone-13-pro-max', S('128', '256', '512', '1TB'), curated('Las reglas previas omitían 1TB.'), { battery: iphoneBattery(false) }),
  iphone('iphone-14-normal', S('128', '256', '512'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-14-plus', S('128', '256', '512'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-14-pro', S('128', '256', '512', '1TB'), curated('Las reglas previas omitían 1TB.'), { battery: iphoneBattery(false) }),
  iphone('iphone-14-pro-max', S('128', '256', '512', '1TB'), curated('Las reglas previas omitían 1TB.'), { battery: iphoneBattery(false) }),
  iphone('iphone-15-normal', S('128', '256', '512'), curated(), { battery: iphoneBattery(true) }),
  iphone('iphone-15-plus', S('128', '256', '512'), curated(), { battery: iphoneBattery(true) }),
  iphone('iphone-15-pro', S('128', '256', '512', '1TB'), curated('Las reglas previas iniciaban en 256.'), { battery: iphoneBattery(true) }),
  iphone('iphone-15-pro-max', S('256', '512', '1TB'), curated(), { battery: iphoneBattery(true) }),
  iphone('iphone-16-normal', S('128', '256', '512'), curated(), { battery: iphoneBattery(true) }),
  iphone('iphone-16-plus', S('128', '256', '512'), curated(), { battery: iphoneBattery(true) }),
  iphone('iphone-16-e', S('128', '256', '512'), curated(), { battery: iphoneBattery(true) }),
  iphone('iphone-16-pro', S('128', '256', '512', '1TB'), curated('Las reglas previas iniciaban en 256.'), { battery: iphoneBattery(true) }),
  iphone('iphone-16-pro-max', S('256', '512', '1TB'), curated(), { battery: iphoneBattery(true) }),
  iphone('iphone-17-normal', S('256', '512'), curated(), { battery: iphoneBattery(true) }),
  iphone('iphone-17-pro', S('256', '512', '1TB'), curated(), { battery: iphoneBattery(true) }),
  iphone('iphone-17-pro-max', S('256', '512', '1TB', '2TB'), curated(), { battery: iphoneBattery(true) }),
  // iPhone 17e: almacenamiento no comprobado; queda desconocido a propósito.
  iphone('iphone-17-e', null, curated(), { battery: iphoneBattery(true) }),
  iphone('iphone-x-air', S('256', '512', '1TB'), curated(), {
    title: 'iPhone Air',
    detalle: { numero: '17', modelo: 'Air' },
    detalleAliases: [{ numero: '', modelo: 'Air' }],
    battery: iphoneBattery(true),
  }),
  iphone('iphone-18-pro', S('256', '512', '1TB', '2TB'), official(URL.iphoneCompare), { battery: iphoneBattery(true) }),
  iphone('iphone-18-pro-max', S('256', '512', '1TB', '2TB'), official(URL.iphoneCompare), { battery: iphoneBattery(true) }),
  iphone('iphone-x-duo', S('256', '512', '1TB', '2TB'), official(URL.iphoneCompare), {
    title: 'iPhone Duo',
    // Sin número en el nombre comercial: se agrupa como "Duo" en el selector de número.
    detalle: { numero: 'Duo', modelo: 'Normal' },
    detalleAliases: [{ numero: '', modelo: 'Duo' }],
    battery: iphoneBattery(true),
  }),
  iphone('iphone-se-2', S('64', '128', '256'), curated(), { battery: iphoneBattery(false) }),
  iphone('iphone-se-3', S('64', '128', '256'), curated(), { battery: iphoneBattery(false) }),
];

// ---------------- iPad ----------------
const screens = (values: Array<{ value: string; diagonal?: string }>, provenance: Provenance) => fact(values, provenance);
const nativeIpadBattery = fact(
  { hasBattery: true, health: 'native' as const, cycles: 'native' as const },
  official(URL.ipadBattery, 'Salud y ciclos en Ajustes > Batería > Salud de la batería.'),
);
const manualIpadBattery = fact(
  { hasBattery: true, health: 'manual' as const, cycles: 'manual' as const },
  official(URL.ipadBattery, 'Modelo no listado con salud nativa; solo diagnóstico manual con procedencia.'),
);

const IPADS: DatasetModelEntry[] = [
  { id: 'ipad-7', screens: screens([{ value: '10.2' }], curated()), storages: fact(S('32', '128'), curated()), battery: manualIpadBattery },
  { id: 'ipad-8', screens: screens([{ value: '10.2' }], projectRules()), storages: fact(S('32', '128'), projectRules()), battery: manualIpadBattery },
  { id: 'ipad-9', screens: screens([{ value: '10.2' }], projectRules()), storages: fact(S('64', '256'), projectRules()), battery: manualIpadBattery },
  { id: 'ipad-10', screens: screens([{ value: '10.9' }], projectRules()), storages: fact(S('64', '256'), projectRules()), battery: manualIpadBattery },
  {
    id: 'ipad-a16',
    title: 'iPad (A16)',
    // Productos previos guardaron esta generación como '11'. Es generación, no pulgadas.
    detalle: { gama: 'Normal', generacion: '11' },
    detalleAliases: [{ gama: 'Normal', generacion: 'A16' }],
    screens: screens([{ value: '11', diagonal: '10.86' }], curated('Pantalla comercial 11"; diagonal técnica 10,86".')),
    storages: fact(S('128', '256', '512'), projectRules()),
    battery: nativeIpadBattery,
  },
  {
    id: 'ipad-mini-5',
    screens: screens([{ value: '7.9' }], official(URL.ipadMini5)),
    storages: fact(S('64', '256'), official(URL.ipadMini5)),
    colors: fact([{ name: 'Space Gray' }, { name: 'Silver' }, { name: 'Gold' }], official(URL.ipadMini5)),
    battery: manualIpadBattery,
  },
  {
    id: 'ipad-mini-6',
    screens: screens([{ value: '8.3' }], official(URL.ipadMini6)),
    storages: fact(S('64', '256'), official(URL.ipadMini6)),
    colors: fact([{ name: 'Space Gray' }, { name: 'Pink' }, { name: 'Purple' }, { name: 'Starlight' }], official(URL.ipadMini6)),
    battery: manualIpadBattery,
  },
  {
    id: 'ipad-mini-a17-pro',
    title: 'iPad mini (A17 Pro)',
    detalle: { gama: 'Mini', generacion: '7' },
    detalleAliases: [{ gama: 'Mini', generacion: 'A17 Pro' }],
    // No se extiende el 8,3" del mini 6 por analogía: queda como dato curado pendiente de su propia ficha.
    screens: screens([{ value: '8.3' }], curated('Verificar con la ficha propia del iPad mini (A17 Pro).')),
    storages: fact(S('128', '256', '512'), projectRules()),
    battery: nativeIpadBattery,
  },
  {
    id: 'ipad-air-a12',
    title: 'iPad Air (3.ª generación)',
    detalle: { gama: 'Air', procesador: 'Gen 3' },
    detalleAliases: [{ gama: 'Air', procesador: 'A12' }],
    screens: screens([{ value: '10.5' }], curated()),
    storages: fact(S('64', '256'), curated()),
    battery: manualIpadBattery,
  },
  {
    id: 'ipad-air-a14',
    title: 'iPad Air (4.ª generación)',
    detalle: { gama: 'Air', procesador: 'Gen 4' },
    detalleAliases: [{ gama: 'Air', procesador: 'A14' }],
    screens: screens([{ value: '10.9' }], projectRules()),
    storages: fact(S('64', '256'), projectRules()),
    battery: manualIpadBattery,
  },
  {
    id: 'ipad-air-m1',
    // Las reglas previas no ofrecían pantalla para Air M1; es única y se autocompleta.
    screens: screens([{ value: '10.9' }], curated()),
    storages: fact(S('64', '256'), curated()),
    conflicts: [{ field: 'storages', detail: 'Reglas previas incluían 128 GB para Air M1; no se publica sin contraste oficial.', sources: [projectRules(), curated()] }],
    battery: manualIpadBattery,
  },
  { id: 'ipad-air-m2', storages: fact(S('128', '256', '512', '1TB'), curated('Las reglas previas omitían 1TB.')), battery: nativeIpadBattery },
  { id: 'ipad-air-m3', storages: fact(S('128', '256', '512', '1TB'), curated('Las reglas previas omitían 1TB.')), battery: nativeIpadBattery },
  { id: 'ipad-air-m4', storages: fact(S('128', '256', '512', '1TB'), curated()), battery: nativeIpadBattery },
  { id: 'ipad-pro-a12z', storages: fact(S('128', '256', '512', '1TB'), curated()), battery: manualIpadBattery },
  { id: 'ipad-pro-m1', storages: fact(S('128', '256', '512', '1TB', '2TB'), projectRules()), battery: manualIpadBattery },
  { id: 'ipad-pro-m2', storages: fact(S('128', '256', '512', '1TB', '2TB'), projectRules()), battery: manualIpadBattery },
  { id: 'ipad-pro-m4', storages: fact(S('256', '512', '1TB', '2TB'), projectRules()), battery: nativeIpadBattery },
  { id: 'ipad-pro-m5', storages: fact(S('256', '512', '1TB', '2TB'), projectRules()), battery: nativeIpadBattery },
];

// ---------------- Apple Watch ----------------
const watchBattery = fact(
  { hasBattery: true, health: 'native' as const, cycles: 'none' as const },
  curated('watchOS muestra la salud de la batería, no un contador de ciclos.'),
);
const ultra = (id: string, provenance: Provenance, extra: Partial<DatasetModelEntry> = {}): DatasetModelEntry => ({
  id,
  caseSizesMm: fact(S('49'), provenance),
  connectivity: fact(['gps_cellular'], provenance),
  battery: watchBattery,
  ...extra,
});
const WATCHES: DatasetModelEntry[] = [
  ...['watch-series-5', 'watch-series-6', 'watch-series-7', 'watch-series-8', 'watch-series-9', 'watch-series-11', 'watch-series-12', 'watch-se-1', 'watch-se-3']
    .map((id) => ({ id, battery: watchBattery })),
  {
    id: 'watch-series-10',
    battery: watchBattery,
    conflicts: [{
      field: 'hardwareModels',
      detail: 'Las reglas previas asignaban A2999 a 42 mm y A2998 a 46 mm; Apple (108056) y AppleDB indican A2997/A2998 = 42 mm GPS y A2999/A3000 = 46 mm GPS. Prevalece la fuente oficial.',
      sources: [projectRules(), official(URL.watchIdentify)],
      resolved: true,
    }],
  },
  {
    id: 'watch-se-2',
    battery: watchBattery,
    conflicts: [{
      field: 'hardwareModels',
      detail: 'Las reglas previas asignaban A2724 a 40 mm; Apple (108056) y AppleDB indican A2724 = 44 mm GPS + Cellular. Prevalece la fuente oficial.',
      sources: [projectRules(), official(URL.watchIdentify)],
      resolved: true,
    }],
  },
  ultra('watch-ultra-1', curated()),
  ultra('watch-ultra-2', official(URL.watchIdentify)),
  ultra('watch-ultra-3', official(URL.ultra3), {
    colors: fact([
      { name: 'Titanium - Natural', label: 'Titanio natural' },
      { name: 'Titanium - Black', label: 'Titanio negro' },
    ], official(URL.ultra3, 'Acabados de caja; los colores de correa no son acabados del equipo.')),
  }),
  ultra('watch-ultra-4', curated()),
];

// ---------------- Mac ----------------
const SSD = (...values: string[]) => values;
const combos = (value: MacCombo[], provenance: Provenance) => fact(value, provenance);
const laptopBattery = fact(
  { hasBattery: true, health: 'native' as const, cycles: 'native' as const },
  curated('macOS muestra condición/capacidad máxima y recuento de ciclos en portátiles.'),
);
const macWeights = (weights: Record<string, number>) => fact(weights, projectRules('Pesos usados para estimar el peso de envío.'));

const MACS: DatasetModelEntry[] = [
  {
    id: 'macbook-air-m1',
    screens: screens([{ value: '13', diagonal: '13.3' }], curated()),
    macCombos: combos([{ ram: S('8', '16'), almacenamiento: SSD('256', '512', '1TB', '2TB') }], projectRules()),
    battery: laptopBattery,
    orderCodes: fact([{ code: 'MGN63', config: { tamano: '13' } }, { code: 'MGN73', config: { tamano: '13' } }], projectRules()),
    weightKg: macWeights({ '13': 1.29 }),
  },
  {
    id: 'macbook-air-m2',
    screens: screens([{ value: '13', diagonal: '13.6' }, { value: '15', diagonal: '15.3' }], curated()),
    macCombos: combos([{ ram: S('8', '16', '24'), almacenamiento: SSD('256', '512', '1TB', '2TB') }], projectRules()),
    hardwareModels: fact([{ model: 'A2681', variant: { tamano: '13' } }, { model: 'A2941', variant: { tamano: '15' } }], projectRules()),
    battery: laptopBattery,
    orderCodes: fact([{ code: 'MLY33', config: { tamano: '13' } }, { code: 'MLY43', config: { tamano: '13' } }, { code: 'MQKW3', config: { tamano: '15' } }], projectRules()),
    weightKg: macWeights({ '13': 1.24, '15': 1.51 }),
  },
  {
    id: 'macbook-air-m3',
    screens: screens([{ value: '13', diagonal: '13.6' }, { value: '15', diagonal: '15.3' }], curated()),
    macCombos: combos([{ ram: S('8', '16', '24'), almacenamiento: SSD('256', '512', '1TB', '2TB') }], projectRules()),
    battery: laptopBattery,
    orderCodes: fact([{ code: 'MRXV3', config: { tamano: '13' } }, { code: 'MRXW3', config: { tamano: '13' } }, { code: 'MRYU3', config: { tamano: '15' } }], projectRules()),
    weightKg: macWeights({ '13': 1.24, '15': 1.51 }),
  },
  {
    id: 'macbook-air-m4',
    screens: screens([{ value: '13', diagonal: '13.6' }, { value: '15', diagonal: '15.3' }], curated()),
    macCombos: combos([{ ram: S('16', '24', '32'), almacenamiento: SSD('256', '512', '1TB', '2TB') }], projectRules()),
    battery: laptopBattery,
    orderCodes: fact([
      ...['MC6T4', 'MW123', 'MW0Y3', 'MW0W3', 'MC6U4', 'MC6V4', 'MW133', 'MC6C4', 'MW103', 'MC6A4', 'MW0X3', 'MC654'].map((code) => ({ code, config: { tamano: '13' } })),
      ...['MC7A4', 'MC7C4', 'MC7D4', 'MW1L3', 'MW1M3', 'MC6L4', 'MC6K4', 'MW1J3', 'MW1K3', 'MW1G3', 'MW1H3', 'MC6J4'].map((code) => ({ code, config: { tamano: '15' } })),
    ], projectRules()),
    weightKg: macWeights({ '13': 1.24, '15': 1.51 }),
  },
  {
    id: 'macbook-air-m5',
    screens: screens([{ value: '13', diagonal: '13.6' }, { value: '15', diagonal: '15.3' }], official(URL.airM5)),
    macCombos: combos([{ ram: S('16', '24', '32'), almacenamiento: SSD('512', '1TB', '2TB', '4TB') }], official(URL.airM5, 'SSD desde 512 GB hasta 4 TB (oficial). RAM según reglas previas, sin contraste oficial.')),
    colors: fact([
      { name: 'Sky Blue', label: 'Azul cielo' },
      { name: 'Midnight', label: 'Medianoche' },
      { name: 'Starlight', label: 'Blanco estrella' },
      { name: 'Silver', label: 'Plata' },
    ], official(URL.airM5)),
    battery: laptopBattery,
    orderCodes: fact([{ code: 'MDHH4', config: {} }, { code: 'MDHJ4', config: {} }, { code: 'MDVQ4', config: {} }], projectRules('Sin tamaño: el número A de 13"/15" está en conflicto entre fuentes.')),
    weightKg: macWeights({ '13': 1.24, '15': 1.51 }),
    conflicts: [{
      field: 'hardwareModels',
      detail: 'AppleDB: A3449 = 13" y A3448 = 15". Reglas previas: A3448 = 13" y A3449 = 15". El tamaño no se deduce del número A hasta revisarlo.',
      sources: [{ source: 'appledb', url: 'https://api.appledb.dev/device/Mac17,3.json' }, projectRules()],
    }],
  },
  {
    id: 'macbook-neo-a18-pro',
    title: 'MacBook Neo (A18 Pro)',
    screens: screens([{ value: '13' }], projectRules()),
    macCombos: combos([{ ram: S('8'), almacenamiento: SSD('256', '512') }], projectRules()),
    battery: laptopBattery,
    orderCodes: fact([
      ...['MHFA4', 'MHFD4', 'MHFF4', 'MHFH4'].map((code) => ({ code, config: { tamano: '13', ram: '8', almacenamiento: '256' } })),
      ...['MHFC4', 'MHFE4', 'MHFG4', 'MHFJ4'].map((code) => ({ code, config: { tamano: '13', ram: '8', almacenamiento: '512' } })),
    ], projectRules('Códigos de pedido con configuración completa.')),
    weightKg: macWeights({ '13': 1.23 }),
  },
  {
    id: 'macbook-pro-m1',
    screens: screens([{ value: '13', diagonal: '13.3' }], official(URL.mbpM1)),
    macCombos: combos([{ ram: S('8', '16'), almacenamiento: SSD('256', '512', '1TB', '2TB') }], official(URL.mbpM1)),
    colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Gray', label: 'Gris espacial' }], official(URL.mbpM1)),
    battery: laptopBattery,
    orderCodes: fact(['MYD83', 'MYD92', 'MYDA2', 'MYDC2'].map((code) => ({ code, config: { tamano: '13' } })), official(URL.mbpIdentify)),
    weightKg: macWeights({ '13': 1.4 }),
  },
  {
    id: 'macbook-pro-m2',
    screens: screens([{ value: '13', diagonal: '13.3' }], curated()),
    macCombos: combos([{ ram: S('8', '16', '24'), almacenamiento: SSD('256', '512', '1TB', '2TB') }], projectRules()),
    colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Gray', label: 'Gris espacial' }], official(URL.mbpIdentify)),
    battery: laptopBattery,
    orderCodes: fact(['MNEH3', 'MNEJ3', 'MNEP3', 'MNEQ3'].map((code) => ({ code, config: { tamano: '13' } })), official(URL.mbpIdentify)),
    weightKg: macWeights({ '13': 1.4 }),
  },
  { id: 'macbook-pro-m1-pro', macCombos: combos([{ ram: S('16', '32'), almacenamiento: SSD('512', '1TB', '2TB', '4TB', '8TB') }], curated('Reglas previas limitaban a 2TB.')), battery: laptopBattery, orderCodes: fact([{ code: 'MKGR3', config: { tamano: '14' } }, { code: 'MKGT3', config: { tamano: '14' } }, { code: 'MK1E3', config: { tamano: '16' } }, { code: 'MK1H3', config: { tamano: '16' } }], projectRules()), weightKg: macWeights({ '14': 1.6, '16': 2.1 }) },
  { id: 'macbook-pro-m1-max', macCombos: combos([{ ram: S('32', '64'), almacenamiento: SSD('512', '1TB', '2TB', '4TB', '8TB') }], projectRules()), battery: laptopBattery },
  { id: 'macbook-pro-m2-pro', macCombos: combos([{ ram: S('16', '32'), almacenamiento: SSD('512', '1TB', '2TB', '4TB', '8TB') }], curated('Reglas previas incluían 36 GB (propio de M3 Pro).')), battery: laptopBattery, orderCodes: fact([{ code: 'MPHE3', config: { tamano: '14' } }, { code: 'MPHF3', config: { tamano: '14' } }, { code: 'MPHG3', config: { tamano: '14' } }, { code: 'MNW83', config: { tamano: '16' } }, { code: 'MNWA3', config: { tamano: '16' } }], projectRules()), weightKg: macWeights({ '14': 1.6, '16': 2.15 }) },
  { id: 'macbook-pro-m2-max', macCombos: combos([{ ram: S('32', '64', '96'), almacenamiento: SSD('512', '1TB', '2TB', '4TB', '8TB') }], projectRules()), battery: laptopBattery },
  { id: 'macbook-pro-m3', screens: screens([{ value: '14', diagonal: '14.2' }], appleDbName()), macCombos: combos([{ ram: S('8', '16', '24'), almacenamiento: SSD('512', '1TB', '2TB') }], projectRules()), colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Gray', label: 'Gris espacial' }], official(URL.mbpIdentify)), battery: laptopBattery, orderCodes: fact([{ code: 'MTL73', config: { tamano: '14' } }], projectRules()), weightKg: macWeights({ '14': 1.55 }) },
  { id: 'macbook-pro-m3-pro', macCombos: combos([{ ram: S('18', '36'), almacenamiento: SSD('512', '1TB', '2TB', '4TB') }], projectRules()), colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Black', label: 'Negro espacial' }], official(URL.mbpIdentify)), battery: laptopBattery, orderCodes: fact([{ code: 'MRX33', config: { tamano: '14' } }, { code: 'MRX43', config: { tamano: '14' } }, { code: 'MRX53', config: { tamano: '14' } }, { code: 'MUW63', config: { tamano: '14' } }, { code: 'MRW13', config: { tamano: '16' } }, { code: 'MRW33', config: { tamano: '16' } }], projectRules()), weightKg: macWeights({ '14': 1.61, '16': 2.14 }) },
  { id: 'macbook-pro-m3-max', macCombos: combos([{ ram: S('36', '48', '64', '96', '128'), almacenamiento: SSD('1TB', '2TB', '4TB', '8TB') }], curated('Reglas previas omitían 96/128 GB.')), colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Black', label: 'Negro espacial' }], official(URL.mbpIdentify)), battery: laptopBattery },
  { id: 'macbook-pro-m4', macCombos: combos([{ ram: S('16', '24', '32'), almacenamiento: SSD('512', '1TB', '2TB') }], curated('Reglas previas ofrecían 8 GB, que no corresponde al M4.')), colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Black', label: 'Negro espacial' }], official(URL.mbpIdentify)), battery: laptopBattery, orderCodes: fact([{ code: 'MW2W3', config: { tamano: '14' } }], projectRules()), weightKg: macWeights({ '14': 1.55 }) },
  { id: 'macbook-pro-m4-pro', macCombos: combos([{ ram: S('24', '48'), almacenamiento: SSD('512', '1TB', '2TB', '4TB') }], projectRules()), colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Black', label: 'Negro espacial' }], official(URL.mbpIdentify)), battery: laptopBattery, orderCodes: fact([{ code: 'MX2E3', config: { tamano: '14' } }, { code: 'MX2F3', config: { tamano: '14' } }, { code: 'MX2T3', config: { tamano: '16' } }], projectRules()), weightKg: macWeights({ '14': 1.6, '16': 2.14 }) },
  { id: 'macbook-pro-m4-max', macCombos: combos([{ ram: S('36', '48', '64', '128'), almacenamiento: SSD('1TB', '2TB', '4TB', '8TB') }], curated()), colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Black', label: 'Negro espacial' }], official(URL.mbpIdentify)), battery: laptopBattery, orderCodes: fact([{ code: 'MX2G3', config: { tamano: '14' } }, { code: 'MX2K3', config: { tamano: '14' } }, { code: 'MX2V3', config: { tamano: '16' } }, { code: 'MX2W3', config: { tamano: '16' } }], projectRules()), weightKg: macWeights({ '14': 1.62, '16': 2.15 }) },
  { id: 'macbook-pro-m5', macCombos: combos([{ ram: S('16', '24'), almacenamiento: SSD('512', '1TB', '2TB') }], projectRules()), colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Black', label: 'Negro espacial' }], official(URL.mbpIdentify)), battery: laptopBattery, orderCodes: fact([{ code: 'MDE44', config: { tamano: '14' } }], official(URL.mbpIdentify)), weightKg: macWeights({ '14': 1.55 }) },
  { id: 'macbook-pro-m5-pro', colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Black', label: 'Negro espacial' }], official(URL.mbpIdentify)), battery: laptopBattery, orderCodes: fact([{ code: 'MGDN4', config: { tamano: '14' } }, { code: 'MGDP4', config: { tamano: '14' } }, { code: 'MGE44', config: { tamano: '16' } }, { code: 'MGE74', config: { tamano: '16' } }], official(URL.mbpIdentify)), weightKg: macWeights({ '14': 1.6, '16': 2.14 }) },
  { id: 'macbook-pro-m5-max', colors: fact([{ name: 'Silver', label: 'Plata' }, { name: 'Space Black', label: 'Negro espacial' }], official(URL.mbpIdentify)), battery: laptopBattery, orderCodes: fact([{ code: 'MGDQ4', config: { tamano: '14' } }, { code: 'MGE94', config: { tamano: '16' } }], projectRules()), weightKg: macWeights({ '14': 1.62, '16': 2.15 }) },
  // Escritorio: sin batería; iMac con pantalla integrada, Mac mini sin pantalla.
  ...[
    ['imac-m1', S('8', '16'), 4.48],
    ['imac-m3', S('8', '16', '24'), 4.43],
    ['imac-m4', S('16', '24', '32'), 4.42],
  ].map(([id, rams, weight]) => ({
    id: id as string,
    screens: screens([{ value: '24', diagonal: '23.5' }], curated('Pantalla comercial 24"; diagonal técnica 23,5".')),
    macCombos: combos([{ ram: rams as string[], almacenamiento: SSD('256', '512', '1TB', '2TB') }], projectRules()),
    weightKg: macWeights({ default: weight as number }),
  })),
  ...[
    ['macmini-m1', S('8', '16'), SSD('256', '512', '1TB', '2TB'), 1.2],
    ['macmini-m2', S('8', '16', '24'), SSD('256', '512', '1TB', '2TB'), 1.18],
    ['macmini-m2-pro', S('16', '32'), SSD('512', '1TB', '2TB', '4TB', '8TB'), 1.28],
    ['macmini-m4', S('16', '24', '32'), SSD('256', '512', '1TB', '2TB'), 0.67],
    ['macmini-m4-pro', S('24', '48', '64'), SSD('512', '1TB', '2TB', '4TB', '8TB'), 0.73],
  ].map(([id, rams, ssds, weight]) => ({
    id: id as string,
    macCombos: combos([{ ram: rams as string[], almacenamiento: ssds as string[] }], curated('RAM según reglas previas; SSD Pro desde 512 GB.')),
    weightKg: macWeights({ default: weight as number }),
  })),
];

function appleDbName(): Provenance {
  return { source: 'appledb:name', url: 'https://api.appledb.dev/device/main.json', license: 'MIT' };
}

// ---------------- AirPods ----------------
const airpods = (id: string, anc: boolean, provenance: Provenance, extra: Partial<DatasetModelEntry> = {}): DatasetModelEntry => ({
  id,
  anc: fact(anc, provenance),
  ...extra,
});
const AIRPODS: DatasetModelEntry[] = [
  airpods('airpods-airpods-2', false, official(URL.airpodsCompare), { caseConnector: fact('Lightning', official(URL.airpodsCompare)) }),
  airpods('airpods-airpods-3', false, official(URL.airpodsCompare), {
    conflicts: [{ field: 'edition', detail: 'AppleDB agrupa los estuches Lightning y MagSafe en una sola edición; no se distingue el estuche.', sources: [appleDbName()] }],
  }),
  airpods('airpods-airpods-4-sin-anc', false, official(URL.airpodsCompare, 'Edición sin "Active Noise Cancellation" en el nombre comercial.'), {
    aliases: ['AirPods 4'],
    caseConnector: fact('USB-C', official(URL.airpodsCompare)),
  }),
  airpods('airpods-airpods-4-con-anc', true, official(URL.airpodsCompare), {
    aliases: ['AirPods 4 ANC', 'AirPods 4 with ANC'],
    caseConnector: fact('USB-C', official(URL.airpodsCompare)),
  }),
  // AirPods 5: ANC en ambos modelos; lo que distingue la edición es el estuche inalámbrico.
  airpods('airpods-airpods-5', true, official(URL.airpods5), { caseConnector: fact('USB-C', official(URL.airpods5)) }),
  airpods('airpods-airpods-5-con-estuche-inalambrico', true, official(URL.airpods5), { caseConnector: fact('USB-C (carga inalámbrica)', official(URL.airpods5)) }),
  airpods('airpods-airpods-pro-1', true, curated()),
  airpods('airpods-airpods-pro-2', true, official(URL.airpodsCompare), { caseConnector: fact('Lightning', curated()) }),
  airpods('airpods-airpods-pro-2-usb-c', true, official(URL.airpodsCompare), { caseConnector: fact('USB-C', official(URL.airpodsCompare)) }),
  airpods('airpods-airpods-pro-3', true, official(URL.airpodsCompare), { caseConnector: fact('USB-C', official(URL.airpodsCompare)) }),
  airpods('airpods-airpods-max', true, official(URL.airpodsCompare), { aliases: ['AirPods Max 1'], caseConnector: fact('Lightning', curated()) }),
  airpods('airpods-airpods-max-usb-c', true, official(URL.airpodsCompare), { caseConnector: fact('USB-C', curated()) }),
  airpods('airpods-airpods-max-2', true, official(URL.airpodsCompare)),
];

// Alcance comercial de AirPods (EveryMac no cubre AirPods): desde AirPods 3, Pro 2 y todas las Max.
const AIRPODS_IN_SCOPE = new Set([
  'airpods-airpods-3', 'airpods-airpods-4-sin-anc', 'airpods-airpods-4-con-anc', 'airpods-airpods-5',
  'airpods-airpods-5-con-estuche-inalambrico', 'airpods-airpods-pro-2', 'airpods-airpods-pro-2-usb-c', 'airpods-airpods-pro-3',
  'airpods-airpods-max', 'airpods-airpods-max-usb-c', 'airpods-airpods-max-2',
]);

export const APPLE_SPECS_DATASET: SpecsDataset = {
  version: '2026.10.22-1',
  publishedAt: '2026-10-22',
  description: 'Dataset inicial: carga manual curada, no es un feed automático.',
  models: [...IPHONES, ...IPADS, ...WATCHES, ...MACS, ...AIRPODS.map((entry) => (AIRPODS_IN_SCOPE.has(entry.id) ? { ...entry, listed: true } : entry))],
};
