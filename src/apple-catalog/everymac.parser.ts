// Lector de fichas técnicas de EveryMac (importación autorizada por EveryMac al titular del negocio).
// Función pura: recibe el HTML ya descargado y devuelve hechos comerciales estructurados.
// No conserva descripciones ni textos de la página; solo valores (chip, pantalla, RAM, SSD, Axxxx...).
import type { CatalogTipo, Connectivity } from './apple-catalog.types';

export interface EveryMacRecord {
  url: string;
  fetchedAt: string;
  title: string;
  tipo: CatalogTipo | null;
  /** Air / Pro / Neo (Mac) · Normal / Mini / Air / Pro (iPad) · Series / SE / Ultra (Watch). */
  gama: string | null;
  chip: string | null;
  cpuCores: number | null;
  gpuCores: number | null;
  /** Generación numérica (iPad 9/10/11, mini 6/7, Air 4/5, Watch Series 10, Ultra 2...). */
  generation: string | null;
  /** iPhone: número y modelo comerciales (17 / Pro Max). */
  iphone: { numero: string; modelo: string } | null;
  /** Pantalla comercial en pulgadas (Mac/iPad) y diagonal técnica si difiere. */
  screen: string | null;
  displayDiagonal: string | null;
  /** Watch: tamaño de caja en mm. */
  caseSizeMm: string | null;
  connectivity: Connectivity | null;
  ramStandard: string[];
  ramOptions: string[];
  storageStandard: string[];
  storageOptions: string[];
  /** La ficha menciona SSD configurables sin enumerarlos. */
  storageIncomplete?: boolean;
  modelNumbers: string[];
  modelIds: string[];
  orderCodes: string[];
  colors: string[];
  introduced: string | null;
  weightKg: number | null;
  warnings: string[];
}

const decode = (html: string) =>
  String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const uniq = <T>(items: T[]) => Array.from(new Set(items));

export const EVERYMAC_URL = /^https:\/\/(?:www\.)?everymac\.com\/systems\/apple\/[a-z0-9_\-/.]+\.html$/i;

interface Pair {
  value: string;
  details: string;
}

/** Pares «Etiqueta: valor» de las tablas de especificaciones, con el texto de detalle asociado. */
export function extractPairs(html: string): Map<string, Pair> {
  const pairs = new Map<string, Pair>();
  const re = /<table[^>]*id="([a-z]+)(\d+)-title"[^>]*>([\s\S]*?)<\/table>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const cells = [...match[3].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decode(cell[1]));
    const detailMatch = html.match(new RegExp(`<table[^>]*id="${match[1]}${match[2]}"[^>]*>([\\s\\S]*?)</table>`, 'i'));
    const details = detailMatch ? decode(detailMatch[1]).replace(/^Details:\s*/i, '') : '';
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const label = cells[i].replace(/:\s*$/, '').trim().toLowerCase();
      if (label && !pairs.has(label)) pairs.set(label, { value: cells[i + 1], details });
    }
  }
  return pairs;
}

const familyFromUrl = (url: string): { tipo: CatalogTipo | null; gama: string | null } => {
  const path = url.toLowerCase();
  if (path.includes('/macbook-air/')) return { tipo: 'macbook', gama: 'Air' };
  if (path.includes('/macbook_pro/') || path.includes('/macbook-pro/')) return { tipo: 'macbook', gama: 'Pro' };
  if (path.includes('/macbook-neo/')) return { tipo: 'macbook', gama: 'Neo' };
  if (path.includes('/imac/')) return { tipo: 'imac', gama: null };
  if (path.includes('/mac_mini/') || path.includes('/mac-mini/')) return { tipo: 'macmini', gama: null };
  if (path.includes('/ipad/')) return { tipo: 'ipad', gama: null };
  if (path.includes('/iphone/')) return { tipo: 'iphone', gama: null };
  if (path.includes('/apple-watch/')) return { tipo: 'watch', gama: null };
  return { tipo: null, gama: null };
};

/** "128, 256, 512 GB; 1 TB" → ['128','256','512','1TB'] (formato de `detalle.almacenamiento`). */
export function parseCapacityList(text: string): string[] {
  // Cada grupo de números toma la unidad que lo cierra: "256 GB, 512 GB, 1 TB" y "128, 256 GB; 1 TB".
  const out: string[] = [];
  const re = /((?:\d+(?:\.\d+)?\s*(?:,|or|and)?\s*)+)\s*(GB|TB)\b(?!\/s)/gi;
  let m: RegExpExecArray | null;
  // Los precios ("US$200, US$600") no son capacidades.
  const clean = String(text || '').replace(/(?:US|CA|AU)?\$\s?[\d,.]+|[€£¥]\s?[\d,.]+/g, ' ');
  while ((m = re.exec(clean))) {
    const unit = m[2].toUpperCase();
    for (const n of m[1].match(/\d+(?:\.\d+)?/g) || []) out.push(unit === 'TB' ? `${n}TB` : n);
  }
  return uniq(out);
}

const sizeValue = (value: string) => (/TB$/.test(value) ? parseFloat(value) * 1024 : parseFloat(value));
const sortSizes = (values: string[]) => uniq(values).sort((a, b) => sizeValue(a) - sizeValue(b));

/** Capacidades de almacenamiento mencionadas en un texto, excluyendo cantidades de RAM y anchos de banda. */
function storageMentions(text: string): string[] {
  // Se quitan las cantidades de RAM ("24 GB of RAM") antes de leer listas como "256, 512 GB" o "1 TB or 2 TB".
  const withoutRam = String(text || '').replace(/\d+\s*GB\s+(?:of\s+)?(?:"?unified"?\s+)?(?:RAM|memory)/gi, ' ');
  return parseCapacityList(withoutRam);
}

/** Descarta frases que hablan de otro chip (p. ej. "si se configura con el M4 Max ... 36 GB"). */
function sameChipSentences(text: string, chip: string | null): string {
  if (!chip) return text;
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    // M1..M12 / A14..A19 (no confundir con números de modelo A3449).
    .filter((sentence) => (sentence.match(/\b(?:M\d{1,2}|A\d{2})(?:\s+(?:Pro|Max|Ultra))?\b/g) || []).every((mention) => mention === chip))
    .join(' ');
}

function ramMentions(text: string): string[] {
  return parseCapacityList(text).filter((value) => !/TB$/.test(value));
}

const KNOWN_COLORS = [
  'Sky Blue', 'Mist Blue', 'Deep Blue', 'Pacific Blue', 'Sierra Blue', 'Cosmic Orange', 'Space Gray', 'Space Black', 'Jet Black', 'Rose Gold',
  'Cloud White', 'Light Gold', 'Alpine Green', 'Deep Purple', 'Midnight', 'Starlight', 'Silver', 'Gold', 'Graphite', 'Natural', 'Slate',
  'Blue', 'Purple', 'Pink', 'Yellow', 'Green', 'Orange', 'Black', 'White', 'Lavender', 'Sage', 'Teal', 'Ultramarine', 'Blush', 'Citrus', 'Indigo', 'Red',
];

/** Acabados nombrados en los textos de carcasa/forma (respaldo cuando AppleDB no trae colores). */
function colorMentions(text: string): string[] {
  let rest = ` ${text} `;
  const found: string[] = [];
  for (const color of KNOWN_COLORS) {
    const re = new RegExp(`(?<![A-Za-z])"?${color.replace(' ', '\\s+')}"?(?![A-Za-z])`, 'i');
    if (re.test(rest)) {
      found.push(color);
      rest = rest.replace(new RegExp(re.source, 'gi'), ' ');
    }
  }
  return found;
}

const IPHONE_FORM = /^iPhone\s+(?:(\d+)(e)?(?:\s+(Pro Max|Pro|Plus|mini))?|(Air|Duo))\b/i;

export function parseEveryMacPage(html: string, url: string, fetchedAt = new Date().toISOString()): EveryMacRecord {
  const pairs = extractPairs(html);
  const get = (label: string) => pairs.get(label.toLowerCase());
  const title = decode(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/:\s*Every(?:Mac|iPad|iPhone)\.com$/i, '');
  const { tipo, gama: urlGama } = familyFromUrl(url);
  const warnings: string[] = [];
  const lowerUrl = url.toLowerCase();

  const processor = (get('processor type')?.value || '').replace(/\*/g, '').replace(/^Apple\s+/i, '').replace(/\s+Bionic$/i, '').trim(); // AppleDB y los productos usan "A14", no "A14 Bionic"
  const chip = processor || null;
  const cores = title.match(/(\d+)\s*CPU\/(\d+)\s*GPU/i) || lowerUrl.match(/(\d+)-core(?:-cpu)?-(\d+)-core-gpu/);

  // Identificadores
  const modelNumbers = uniq([...(get('apple model no')?.value || '').matchAll(/\bA\d{4}\b/g)].map((m) => m[0]).concat((title.match(/\bA\d{4}\b/g) || [])));
  const modelIds = uniq(((get('model id')?.value || '') + ' ' + title).match(/\b(?:Mac|MacBookAir|MacBookPro|Macmini|iMac|iPad|iPhone|Watch)\d+,\d+\b/g) || []);
  const orderText = `${get('apple order no')?.value || ''} ${get('apple order no')?.details || ''}`;
  const orderCodes = uniq([...orderText.matchAll(/\b([A-Z][A-Z0-9]{3}\d)[A-Z]{1,2}\/A\b/g)].map((m) => m[1]));

  // Pantalla comercial y diagonal técnica
  const subfamily = get('apple subfamily')?.value || '';
  const displayValue = get('built-in display')?.value || '';
  const displayDetails = get('built-in display')?.details || '';
  let screen: string | null = null;
  let displayDiagonal: string | null = null;
  if (tipo === 'macbook' || tipo === 'imac') {
    // El título lleva el chip entre comillas ("M1"): la pantalla es un número de 2 dígitos precedido de espacio.
    screen = subfamily.match(/(\d+(?:\.\d+)?)-Inch/i)?.[1] || title.match(/(?:^|\s)(\d{2}(?:\.\d)?)"/)?.[1] || lowerUrl.match(/-(\d{2})-(?:inch-)?(?:retina|20\d\d|late|four|two)/)?.[1] || null;
    displayDiagonal = displayValue.match(/(\d+(?:\.\d+)?)"/)?.[1] || null;
  } else if (tipo === 'ipad') {
    screen = displayValue.match(/(\d+(?:\.\d+)?)"/)?.[1] || title.match(/(\d+(?:\.\d+)?)"/)?.[1] || null;
    // El texto nombra la medida comercial y la diagonal real (p. ej. "11-inch ... 10.86-inch"): se toma la que difiere.
    const mentioned = [...displayDetails.matchAll(/(\d+(?:\.\d+)?)-inch/gi)].map((m) => m[1]);
    displayDiagonal = mentioned.find((value) => screen && Math.abs(Number(value) - Number(screen)) >= 0.05 && Math.abs(Number(value) - Number(screen)) < 1) || null;
  }
  if (displayDiagonal && screen && Math.abs(Number(displayDiagonal) - Number(screen)) < 0.05) displayDiagonal = null;

  // Conectividad, generación y gama según familia
  let connectivity: Connectivity | null = null;
  let gama = urlGama;
  let generation: string | null = null;
  let caseSizeMm: string | null = null;
  let iphone: EveryMacRecord['iphone'] = null;
  if (tipo === 'ipad') {
    connectivity = /cell|lte|5g/i.test(`${title} ${lowerUrl}`) ? 'cellular' : 'wifi';
    gama = /ipad[\s-]+air/i.test(`${title} ${lowerUrl}`) ? 'Air' : /ipad[\s-]+pro/i.test(`${title} ${lowerUrl}`) ? 'Pro' : /ipad[\s-]+mini/i.test(`${title} ${lowerUrl}`) ? 'Mini' : 'Normal';
    generation = lowerUrl.match(/(\d+)(?:st|nd|rd|th)-gen/)?.[1] || null;
  } else if (tipo === 'watch') {
    const line = /ultra/i.test(title) ? 'Ultra' : /\bSE\b/.test(title) ? 'SE' : 'Series';
    gama = line;
    generation = title.match(/(?:Series|Ultra|SE)\s+(\d+)/i)?.[1] || (line === 'Series' ? null : '1');
    caseSizeMm = title.match(/(\d+)\s*mm/i)?.[1] || null;
    connectivity = line === 'Ultra' || /cellular/i.test(`${title} ${lowerUrl}`) ? 'gps_cellular' : 'gps';
  } else if (tipo === 'iphone') {
    const form = (get('form factor')?.value || subfamily || title).trim();
    const m = form.match(IPHONE_FORM) || title.match(IPHONE_FORM);
    if (m) {
      if (m[4]) iphone = { numero: '', modelo: m[4][0].toUpperCase() + m[4].slice(1).toLowerCase() };
      else {
        const suffix = m[3] || '';
        iphone = {
          numero: m[1],
          modelo: m[2] ? 'E' : suffix ? (/^mini$/i.test(suffix) ? 'Mini' : suffix.replace(/\b\w/g, (c) => c.toUpperCase())) : 'Normal',
        };
      }
    } else warnings.push('No se reconoció el modelo de iPhone.');
  }

  // Capacidades
  let ramStandard: string[] = [];
  let ramOptions: string[] = [];
  let storageStandard: string[] = [];
  let storageOptions: string[] = [];
  let storageIncomplete = false;
  if (tipo === 'macbook' || tipo === 'imac' || tipo === 'macmini') {
    const std = get('standard ram');
    const max = get('maximum ram');
    ramStandard = uniq(ramMentions(std?.value || ''));
    const maxRam = Math.max(0, ...ramMentions(max?.value || '').map(Number));
    const minRam = Math.min(...ramStandard.map(Number));
    const mentioned = ramMentions(sameChipSentences(`${std?.details || ''} ${max?.details || ''}`, chip)).filter((n) => Number(n) >= minRam && (!maxRam || Number(n) <= maxRam));
    ramOptions = sortSizes([...ramStandard, ...mentioned, ...(maxRam ? [String(maxRam)] : [])]);
    const storage = get('standard storage');
    storageStandard = sortSizes(storageMentions(storage?.value || ''));
    const minStorage = Math.min(...storageStandard.map(sizeValue));
    storageOptions = sortSizes([...storageStandard, ...storageMentions(sameChipSentences(storage?.details || '', chip))].filter((v) => sizeValue(v) >= Math.max(128, minStorage)));
    // "could be configured with higher capacity" sin enumerar: el mapeo completa con fichas hermanas del mismo chip.
    storageIncomplete = /higher capacity|larger capacity/i.test(storage?.details || '') && storageOptions.length <= storageStandard.length;
    if (storageIncomplete) warnings.push('La ficha no enumera las opciones de SSD configurables.');
    if (!ramStandard.length) warnings.push('Sin RAM estándar.');
    if (!storageStandard.length) warnings.push('Sin almacenamiento estándar.');
  } else if (tipo === 'ipad' || tipo === 'iphone') {
    storageOptions = sortSizes(parseCapacityList(get('storage capacity')?.value || ''));
    storageStandard = storageOptions;
    if (!storageOptions.length) warnings.push('Sin capacidades de almacenamiento.');
  }

  const colorText = [get('housing color'), get('form factor'), get('case type')].map((p) => `${p?.value || ''} ${p?.details || ''}`).join(' ');
  const weightText = get('avg. weight')?.value || '';
  const kg = weightText.match(/\(([\d.]+)\s*kg\)/i)?.[1];
  const grams = weightText.match(/\(([\d.]+)\s*g\)/i)?.[1];
  const introducedRaw = get('introduction date')?.value || '';
  const introducedDate = introducedRaw ? new Date(`${introducedRaw.replace(/\*/g, '')} UTC`) : null;

  if (!tipo) warnings.push('La URL no corresponde a una familia soportada.');
  if (!chip && tipo !== 'watch') warnings.push('Sin tipo de procesador.');
  if ((tipo === 'macbook' || tipo === 'imac') && !screen) warnings.push('Sin pantalla comercial.');
  if (tipo === 'watch' && !caseSizeMm) warnings.push('Sin tamaño de caja.');

  return {
    url,
    fetchedAt,
    title,
    tipo,
    gama,
    chip,
    cpuCores: cores ? Number(cores[1]) : null,
    gpuCores: cores ? Number(cores[2]) : null,
    generation,
    iphone,
    screen,
    displayDiagonal,
    caseSizeMm,
    connectivity,
    ramStandard,
    ramOptions,
    storageStandard,
    storageOptions,
    storageIncomplete,
    modelNumbers,
    modelIds,
    orderCodes,
    colors: colorMentions(colorText),
    introduced: introducedDate && !Number.isNaN(introducedDate.getTime()) ? introducedDate.toISOString().slice(0, 10) : null,
    weightKg: kg ? Number(kg) : grams ? Number(grams) / 1000 : null,
    warnings,
  };
}
