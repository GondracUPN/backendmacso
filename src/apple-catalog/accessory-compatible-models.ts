import type { AppleCatalogModel } from './apple-catalog.types';

type CompatibilityModel = {
  id: string;
  family: 'iphone' | 'ipad' | 'macbook';
  series?: string;
  range: string;
  label: string;
  screen: string;
  chip: string;
  year: number;
};

// Apple Support (108044) and apple.com/iphone/compare. The product form has no iPhone size selector.
const iphoneScreens: Record<string, string> = {
  '13-mini': '5.4″', '13-normal': '6.1″', '13-pro': '6.1″', '13-pro-max': '6.7″',
  '14-normal': '6.1″', '14-plus': '6.7″', '14-pro': '6.1″', '14-pro-max': '6.7″',
  '15-normal': '6.1″', '15-plus': '6.7″', '15-pro': '6.1″', '15-pro-max': '6.7″',
  '16-e': '6.1″', '16-normal': '6.1″', '16-plus': '6.7″', '16-pro': '6.3″', '16-pro-max': '6.9″',
  '17-e': '6.1″', '17-normal': '6.3″', '17-pro': '6.3″', '17-pro-max': '6.9″',
  '18-pro': '6.3″', '18-pro-max': '6.9″', 'x-air': '6.5″', 'x-duo': '5.4″ / 7.6″',
};

// Models outside the commercial intake window or absent from the packaged feed.
// Apple Support: 108043, 149482, 102869, 108052.
const extraModels: CompatibilityModel[] = [
  { id: 'ipad-5', family: 'ipad', range: 'Normal', label: 'iPad (5.ª generación)', screen: '9.7″', chip: 'A9', year: 2017 },
  { id: 'ipad-6', family: 'ipad', range: 'Normal', label: 'iPad (6.ª generación)', screen: '9.7″', chip: 'A10', year: 2018 },
  { id: 'ipad-pro-a10x:10.5', family: 'ipad', range: 'Pro', label: 'iPad Pro 10.5″ (A10X)', screen: '10.5″', chip: 'A10X', year: 2017 },
  { id: 'ipad-pro-a10x:12.9', family: 'ipad', range: 'Pro', label: 'iPad Pro 12.9″ (A10X)', screen: '12.9″', chip: 'A10X', year: 2017 },
  { id: 'ipad-pro-a12x:11', family: 'ipad', range: 'Pro', label: 'iPad Pro 11″ (A12X)', screen: '11″', chip: 'A12X', year: 2018 },
  { id: 'ipad-pro-a12x:12.9', family: 'ipad', range: 'Pro', label: 'iPad Pro 12.9″ (A12X)', screen: '12.9″', chip: 'A12X', year: 2018 },
  { id: 'ipad-mini-a20-pro:8.5', family: 'ipad', range: 'Mini', label: 'iPad mini (A20 Pro)', screen: '8.5″', chip: 'A20 Pro', year: 2026 },
  { id: 'macbook-air-intel-2020', family: 'macbook', range: 'Air', label: 'MacBook Air 13″ (Intel, 2020)', screen: '13″', chip: 'Intel Core i3 / i5 / i7', year: 2020 },
  { id: 'macbook-pro-intel-2020-2', family: 'macbook', range: 'Pro', label: 'MacBook Pro 13″ (Intel, 2020, 2 puertos)', screen: '13″', chip: 'Intel Core i5 / i7', year: 2020 },
  { id: 'macbook-pro-intel-2020-4', family: 'macbook', range: 'Pro', label: 'MacBook Pro 13″ (Intel, 2020, 4 puertos)', screen: '13″', chip: 'Intel Core i5 / i7', year: 2020 },
];
const firstYear = { iphone: 2021, ipad: 2017, macbook: 2020 };

export function accessoryCompatibleModels(models: AppleCatalogModel[], today: string): CompatibilityModel[] {
  const rows = new Map(extraModels.map((row) => [row.id, row]));
  for (const model of models) {
    const { tipo: family, detalle, released, title, id } = model;
    if (family !== 'iphone' && family !== 'ipad' && family !== 'macbook') continue;
    if (!released || released > today) continue;
    const year = Number(released.slice(0, 4));
    if (year < firstYear[family] || (family === 'iphone' && (released < '2021-09-24' || detalle.numero === 'SE'))) continue;

    const range = (family === 'iphone' ? detalle.modelo : detalle.gama) || 'Normal';
    const chip = model.chip || detalle.procesador || '';
    if (family === 'iphone') {
      const iphoneRange = id === 'iphone-x-duo' ? 'Duo' : range;
      const series = id.match(/^iphone-(\d+)-/)?.[1] || title.replace(/^iPhone\s+/i, '');
      rows.set(id, { id, family, series, range: iphoneRange,
        label: title, screen: iphoneScreens[id.replace(/^iphone-/, '')] || '', chip, year });
      continue;
    }

    const sizes = model.selectors.find((selector) => selector.field === 'tamano')?.options ?? [];
    // Los tamaños corresponden a carcasas distintas. Wi-Fi, región y capacidad comparten la opción.
    for (const size of sizes.length ? sizes.map((option) => option.value) : ['']) {
      if (!size && extraModels.some((row) => row.id === id || row.id.startsWith(id + ':'))) continue;
      const rowId = size ? `${id}:${size}` : id;
      const screen = size ? `${size}″` : '';
      const includeSize = screen && (family === 'macbook' || range === 'Pro' || range === 'Air' || sizes.length > 1);
      const titleWithSize = title.includes('(') ? title.replace(/\s*\(/, ` ${screen} (`) : `${title} ${screen}`;
      const label = includeSize ? titleWithSize : title;
      rows.set(rowId, { id: rowId, family, range, label, screen, chip, year });
    }
  }
  return [...rows.values()].sort((a, b) => b.year - a.year || a.label.localeCompare(b.label, 'es', { numeric: true }));
}
