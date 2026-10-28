import { mapRecordToModel, mergeEveryMacEntries, recordsToDatasetEntries } from './everymac.mapper';
import { parseCapacityList, parseEveryMacPage } from './everymac.parser';
import { normalizeEveryMacUrl } from './everymac.provider';
import { APPLE_SPECS_DATASET } from './data/apple-specs.dataset';

// HTML sintético con la misma estructura de tablas que usan las fichas (sin copiar contenido real).
const table = (n: number, pairs: Array<[string, string]>, details = '') => `
<div id="contentcenter_specs_table_pairs"><table id="specs${n}-title" class="handcursor"><tr>
${pairs.map(([label, value]) => `<td class="mocklink">${label}:</td><td>${value}</td>`).join('')}
</tr></table></div>
<div id="contentcenter_specs_table_details"><table id="specs${n}" class="switchgroup1"><tr><td>Details:</td><td>${details}</td></tr></table></div>`;
const page = (title: string, body: string) => `<html><head><title>${title}: EveryMac.com</title></head><body><div id="contentcenter_specs_table">${body}</div></body></html>`;

const macHtml = page('MacBook Air &quot;M9&quot; 12 CPU/10 GPU 13&quot; Specs (13-Inch, M9, 2030, MZZZ1LL/A*, Mac30,1, A9001, 9999*)', [
  table(1, [['Introduction Date', 'March 3, 2030'], ['Discontinued Date', 'N/A']]),
  table(2, [['Processor Speed', '5 GHz'], ['Processor Type', 'Apple M9']]),
  table(3, [['Standard RAM', '16 GB, 24 GB*'], ['Maximum RAM', '48 GB*']], '*It also can be custom configured with 32 GB or 48 GB of RAM. Bandwidth 200 GB/s.'),
  table(4, [['Built-in Display', '13.6&quot; 16:10'], ['Native Resolution', '2560x1664']]),
  table(5, [['Standard Storage', '512 GB, 1 TB SSD*'], ['Std. Storage Speed', 'Onboard']], '*Default 16 GB of RAM and a 1 TB SSD. It also could be configured with a 2 TB or 4 TB SSD.'),
  table(6, [['Form Factor', 'MacBook Air 2030 M9 13&quot;']], 'Color options -- "Sky Blue", "Midnight", Silver.'),
  table(7, [['Apple Order No', 'MZZZ1LL/A*'], ['Apple Subfamily', '13-Inch, M9, 2030']], '*In Silver it is MZZZ2LL/A.'),
  table(8, [['Apple Model No', 'A9001 (EMC 9999*)'], ['Model ID', 'Mac30,1']]),
  table(9, [['Dimensions', '1 x 2 x 3'], ['Avg. Weight', '2.7 lbs (1.23 kg)']]),
].join(''));
const MAC_URL = 'https://everymac.com/systems/apple/macbook-air/specs/macbook-air-m9-12-core-cpu-10-core-gpu-13-2030-specs.html';

describe('parseEveryMacPage', () => {
  it('extrae chip, pantalla, RAM y SSD configurables sin confundir RAM ni ancho de banda con almacenamiento', () => {
    const r = parseEveryMacPage(macHtml, MAC_URL, '2030-03-10T00:00:00Z');
    expect(r).toMatchObject({
      tipo: 'macbook', gama: 'Air', chip: 'M9', cpuCores: 12, gpuCores: 10, screen: '13', displayDiagonal: '13.6',
      ramStandard: ['16', '24'], ramOptions: ['16', '24', '32', '48'], storageOptions: ['512', '1TB', '2TB', '4TB'],
      modelNumbers: ['A9001'], modelIds: ['Mac30,1'], orderCodes: ['MZZZ1', 'MZZZ2'], introduced: '2030-03-03', weightKg: 1.23,
      warnings: [],
    });
    expect(r.colors).toEqual(expect.arrayContaining(['Sky Blue', 'Midnight', 'Silver']));
  });

  it('iPad/iPhone/Watch: capacidad, conectividad, caja y generación desde título/URL', () => {
    const ipad = parseEveryMacPage(page('iPad Air M9 11&quot; (Wi-Fi+Cell) 128, 256 GB; 1 TB Specs (A9100)', [
      table(1, [['Processor Type', 'Apple M9'], ['Onboard RAM', '12 GB*']]),
      table(2, [['Storage Capacity', '128, 256 GB; 1 TB']]),
      table(3, [['Built-in Display', '11&quot; Liquid Retina*']], '*The 11-inch models have a 10.86-inch display.'),
    ].join('')), 'https://everymac.com/systems/apple/ipad/specs/apple-ipad-air-m9-11-inch-2030-wifi-cellular-specs.html');
    expect(ipad).toMatchObject({ tipo: 'ipad', gama: 'Air', chip: 'M9', screen: '11', displayDiagonal: '10.86', connectivity: 'cellular', storageOptions: ['128', '256', '1TB'] });
    expect(ipad.ramOptions).toEqual([]); // la RAM de iPad no es dato comercial

    const watch = parseEveryMacPage(page('Apple Watch Series 15 (GPS, 46 mm) Specs (A9200)', table(1, [['Processor Type', 'Apple S15']])),
      'https://everymac.com/systems/apple/apple-watch/specs/apple-watch-series-15-aluminum-gps-46mm.html');
    expect(watch).toMatchObject({ tipo: 'watch', gama: 'Series', generation: '15', caseSizeMm: '46', connectivity: 'gps' });

    const iphone = parseEveryMacPage(page('iPhone 22 Pro Max (Global) Specs', [table(1, [['Storage Capacity', '256, 512 GB; 1, 2 TB']]), table(2, [['Form Factor', 'iPhone 22 Pro Max']])].join('')),
      'https://everymac.com/systems/apple/iphone/specs/apple-iphone-22-pro-max-global-a9300-specs.html');
    expect(iphone).toMatchObject({ iphone: { numero: '22', modelo: 'Pro Max' }, storageOptions: ['256', '512', '1TB', '2TB'] });
  });

  it('parseCapacityList respeta GB/TB por tramo', () => {
    expect(parseCapacityList('64, 256 GB')).toEqual(['64', '256']);
    expect(parseCapacityList('128, 256, 512 GB; 1 TB')).toEqual(['128', '256', '512', '1TB']);
  });
});

describe('everymac.mapper', () => {
  const record = parseEveryMacPage(macHtml, MAC_URL, '2030-03-10T00:00:00Z');

  it('agrupa por gama + procesador y crea un bloque RAM/SSD por pantalla (sin producto cartesiano entre fichas)', () => {
    const r15 = { ...record, url: `${MAC_URL}?15`, screen: '15', displayDiagonal: '15.3', ramOptions: ['24', '32'], storageOptions: ['1TB', '2TB'] };
    const { entries } = recordsToDatasetEntries([record, r15]);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toMatchObject({ id: 'macbook-air-m9', tipo: 'macbook', detalle: { gama: 'Air', procesador: 'M9' } });
    expect(entry.macCombos!.value).toEqual([
      { tamano: ['13'], ram: ['16', '24', '32', '48'], almacenamiento: ['512', '1TB', '2TB', '4TB'] },
      { tamano: ['15'], ram: ['24', '32'], almacenamiento: ['1TB', '2TB'] },
    ]);
    expect(entry.screens!.value).toEqual([{ value: '13', diagonal: '13.6' }, { value: '15', diagonal: '15.3' }]);
    expect(entry.hardwareModels!.value[0]).toEqual({ model: 'A9001', variant: { tamano: '13' } });
    expect(entry.macCombos!.provenance.source).toBe('everymac');
  });

  it('reutiliza el ID existente (iPad 11.ª gen = ipad-a16) y conserva título/detalle canónicos del dataset', () => {
    const ipad = { ...record, tipo: 'ipad' as const, gama: 'Normal', chip: 'A16', generation: '11', screen: '11', ramOptions: [], storageOptions: ['128', '256', '512'], connectivity: 'wifi' as const };
    expect(mapRecordToModel(ipad, new Set(['ipad-a16']))!.id).toBe('ipad-a16');
    const { entries } = recordsToDatasetEntries([ipad], new Set(['ipad-a16']));
    const merged = mergeEveryMacEntries(APPLE_SPECS_DATASET, entries).models.find((m) => m.id === 'ipad-a16')!;
    expect(merged.detalle).toEqual({ gama: 'Normal', generacion: '11' });
    expect(merged.listed).toBe(true);
    expect(merged.storages!.provenance.source).toBe('everymac');
  });

  it('no reemplaza un hecho oficial: lo deja como conflicto', () => {
    const mini = { ...record, tipo: 'ipad' as const, gama: 'Mini', chip: 'A15', generation: '6', screen: '8.3', ramOptions: [], storageOptions: ['64', '128'], connectivity: 'wifi' as const };
    const { entries } = recordsToDatasetEntries([mini], new Set(['ipad-mini-6']));
    const merged = mergeEveryMacEntries(APPLE_SPECS_DATASET, entries).models.find((m) => m.id === 'ipad-mini-6')!;
    expect(merged.storages!.value).toEqual(['64', '256']);
    expect(merged.conflicts!.some((c) => c.field === 'storages')).toBe(true);
  });
});

describe('normalizeEveryMacUrl', () => {
  it('solo admite fichas https de everymac.com', () => {
    expect(normalizeEveryMacUrl('http://www.everymac.com/systems/apple/imac/specs/x.html?a=1')).toBe('https://everymac.com/systems/apple/imac/specs/x.html');
    expect(() => normalizeEveryMacUrl('https://evil.example/systems/apple/x.html')).toThrow('Enlace no admitido');
  });
});
