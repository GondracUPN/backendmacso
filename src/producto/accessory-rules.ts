const clean = (value: unknown) => String(value ?? '').trim();
const slug = (value: unknown) => clean(value).toLowerCase();

export const isAccessoryStock = (tipo: unknown): boolean => slug(tipo) === 'accesorios';

const GROUPS: Record<string, string[][]> = {
  macbook: [['Cubo original', 'Cubo fake'], ['Cable original', 'Cable fake']],
  ipad: [['Cubo original', 'Cubo fake'], ['Cable original', 'Cable fake'], ['Magic Keyboard', 'Keyboard Logitech', 'Keyboard otros']],
  iphone: [['Cubo original', 'Cubo fake'], ['Cable original', 'Cable fake']],
  macmini: [['Cable de poder original', 'Cable de poder generico']],
};

const ALLOWED: Record<string, string[]> = {
  macbook: ['Caja', 'Cubo original', 'Cubo fake', 'Cable original', 'Cable fake', 'Case', 'Mica'],
  ipad: ['Caja', 'Cubo original', 'Cubo fake', 'Cable original', 'Cable fake', 'Case', 'Mica', 'Magic Keyboard', 'Keyboard Logitech', 'Keyboard otros'],
  iphone: ['Caja', 'Cubo original', 'Cubo fake', 'Cable original', 'Cable fake', 'Funda', 'Mica'],
  watch: ['Caja', 'Cable', 'Case', 'Correa'],
  macmini: ['Caja', 'Cable de poder original', 'Cable de poder generico'],
  airpods: ['Caja', 'Cable', 'Case', 'Eartips'],
};

export function normalizeIncludedAccessories(tipo: unknown, values: unknown, airpodsModel?: unknown): string[] {
  const type = slug(tipo);
  if (isAccessoryStock(type)) return [];
  let allowed = ALLOWED[type] || ['Caja'];
  if (type === 'airpods') {
    const model = slug(airpodsModel);
    if (model.includes('max')) allowed = ['Caja', 'Cable'];
    else if (model.includes('pro 2')) allowed = ['Caja', 'Cable', 'Case', 'Eartips'];
    else if (model.includes('pro 3')) allowed = ['Caja', 'Eartips'];
    else if (model.includes('airpods 4') || model === '4' || model.includes('4 anc')) allowed = ['Caja', 'Eartips'];
    else allowed = ['Caja'];
  }
  const canonical = new Map(allowed.map((item) => [slug(item), item]));
  const requested = Array.isArray(values) ? values.map(clean).filter(Boolean) : [];
  const selected: string[] = ['Caja'];
  for (const item of requested) {
    const normalized = canonical.get(slug(item));
    if (normalized && normalized !== 'Caja' && !selected.includes(normalized)) selected.push(normalized);
  }
  for (const group of GROUPS[type] || []) {
    const matches = selected.filter((item) => group.includes(item));
    if (matches.length > 1) {
      const keep = matches[matches.length - 1];
      matches.filter((item) => item !== keep).forEach((item) => selected.splice(selected.indexOf(item), 1));
    }
  }
  return selected;
}
