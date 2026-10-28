// Reconocedor único de serial e IMEI a partir del texto (y, si existen, las cajas) que devuelve Cloud Vision.
// Es puro y sin red: el servicio OCR lo alimenta con una o varias pasadas y los dos escáneres del frontend
// consumen sus candidatos tipados. Nunca registra valores.
import { normalizeImei, normalizeSerial } from '../apple-catalog/device-capabilities';

export type OcrBox = { x: number; y: number; width: number; height: number };
export type OcrWord = { text: string; box?: OcrBox | null; confidence?: number | null };
export type OcrPassKind = 'full' | 'enhanced' | 'zoom' | 'manual';
export type OcrPass = { id: string; kind: OcrPassKind; text?: string; words?: OcrWord[] };

export type IdentifierKind = 'serial' | 'imei';
export type ImeiSlot = 'imei1' | 'imei2' | null;
export type SerialComponent = 'case' | 'left' | 'right' | null;
export type LabelEvidence = 'same_line' | 'previous_line' | 'column' | 'none';

export interface IdentifierCorrection {
  index: number;
  from: string;
  to: string;
  reason: string;
}

export interface IdentifierValidation {
  status: 'valid' | 'invalid' | 'review';
  rule: 'luhn' | 'apple_serial';
  message?: string;
}

export interface IdentifierCandidate {
  id: string;
  kind: IdentifierKind;
  value: string;
  rawValue: string;
  /** Etiqueta leída junto al valor (p. ej. "IMEI2", "SERIAL NO"); null si no hay. */
  label: string | null;
  slot: ImeiSlot;
  component: SerialComponent;
  labelEvidence: LabelEvidence;
  confidence: number;
  confidenceSource: 'heuristic' | 'heuristic+vision';
  validation: IdentifierValidation;
  warnings: string[];
  sourcePass: string;
  sourcePasses: string[];
  /** Coordenadas en la imagen original ya orientada (EXIF aplicado). */
  boundingBox: OcrBox | null;
  corrections: IdentifierCorrection[];
  /** Solo los candidatos con etiqueta, validados, sin ambigüedad ni conflicto pueden autocompletarse. */
  autofill: boolean;
}

export interface IdentifierConflict {
  type: 'serial_conflict' | 'slot_conflict' | 'same_value_both_slots';
  slot?: ImeiSlot;
  component?: SerialComponent;
  values: string[];
}

export interface RecognitionResult {
  candidates: IdentifierCandidate[];
  conflicts: IdentifierConflict[];
  serial: string;
  imei1: string;
  imei2: string;
  serials: string[];
  imeis: string[];
  /** Etiquetas de serial/IMEI encontradas (con caja si la hay), usadas para decidir recortes de reintento. */
  labels: Array<{ type: 'serial' | 'imei'; passId: string; box: OcrBox | null; hasValue: boolean }>;
}

type Token = { raw: string; norm: string; box: OcrBox | null; conf: number | null };
type Line = { tokens: Token[] };
type LabelMatch = {
  type: 'serial' | 'imei' | 'negative';
  length: number;
  text: string;
  slot?: 'imei1' | 'imei2' | 'plain';
  component?: SerialComponent;
};
type LabelHit = LabelMatch & { line: number; start: number; end: number; box: OcrBox | null };
type Draft = Omit<IdentifierCandidate, 'id' | 'sourcePasses' | 'autofill' | 'confidence'> & {
  confidence: number;
  order: number;
};

const AUTOFILL_MIN_CONFIDENCE = 0.6;
const AMBIGUOUS_DIGITS: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', Z: '2', S: '5', B: '8', G: '6' };
const NEGATIVE_LABELS = new Set([
  'MODEL', 'MODELO', 'PART', 'P/N', 'PN', 'MPN', 'UPC', 'EAN', 'GTIN', 'SKU', 'MAC', 'WI-FI', 'WIFI', 'BLUETOOTH',
  'ETHERNET', 'EID', 'ICCID', 'MEID', 'ORDER', 'PEDIDO', 'ORDEN', 'INVOICE', 'FACTURA', 'FCC', 'IC', 'CMIIT',
  'ANATEL', 'IFETEL', 'IFT', 'NCC', 'TA', 'REF', 'LOT', 'BATCH', 'CAPACITY', 'CAPACIDAD', 'COLOR', 'DATE', 'FECHA',
  'DESIGNED', 'DISENADO', 'ASSEMBLED', 'ENSAMBLADO', 'MADE', 'IMPORTED', 'IMPORTADO', 'CONFIG', 'CPID', 'TRACKING',
]);
const SERIAL_STOP_WORDS = new Set([
  'APPLE', 'CALIFORNIA', 'DESIGNED', 'ASSEMBLED', 'CHINA', 'MODEL', 'MODELO', 'NUMBER', 'SERIAL', 'SERIE', 'IMEI',
  'MEID', 'ICCID', 'MACBOOK', 'IPHONE', 'IPAD', 'WATCH', 'AIRPODS', 'ORIGINAL', 'COLOR', 'CAPACITY', 'UNKNOWN',
  'PENDIENTE', 'DESCONOCIDO', 'NOTAVAILABLE', 'UNAVAILABLE',
]);
const SERIAL_SUFFIXES = new Set(['NO', 'NUMBER', 'NUM', 'NR', 'NRO', '#', 'N°', 'Nº']);
const NUMBER_WORDS = new Set(['NUMERO', 'NUM', 'NRO', 'NO', 'N°', 'Nº', 'N']);
const COMPONENT_WORDS: Record<string, SerialComponent> = {
  CASE: 'case', ESTUCHE: 'case', CHARGING: 'case', CARGA: 'case',
  LEFT: 'left', IZQUIERDO: 'left', IZQUIERDA: 'left', IZQ: 'left',
  RIGHT: 'right', DERECHO: 'right', DERECHA: 'right', DER: 'right',
};

const stripAccents = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '');
const normToken = (raw: string) =>
  stripAccents(String(raw || '').toUpperCase())
    .replace(/^[\s([{"'“”.,;:]+/, '')
    .replace(/[\s)\]}"'“”.,;:]+$/, '');
const isPunctuation = (norm: string) => norm === '' || /^[^A-Z0-9/#°º|]+$/.test(norm);
const round = (value: number) => Math.round(value * 100) / 100;
const clamp01 = (value: number) => Math.max(0.01, Math.min(0.99, value));

export function luhnValid(digits: string) {
  if (!/^\d{15}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const unionBoxes = (boxes: Array<OcrBox | null | undefined>): OcrBox | null => {
  const valid = boxes.filter(Boolean) as OcrBox[];
  if (!valid.length) return null;
  const minX = Math.min(...valid.map((box) => box.x));
  const minY = Math.min(...valid.map((box) => box.y));
  const maxX = Math.max(...valid.map((box) => box.x + box.width));
  const maxY = Math.max(...valid.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

const visionConfidence = (tokens: Token[]) => {
  const values = tokens.map((token) => token.conf).filter((conf): conf is number => typeof conf === 'number' && conf > 0);
  return values.length ? values.reduce((sum, conf) => sum + conf, 0) / values.length : null;
};

// ---------------- Líneas ----------------

const tokensFromText = (line: string): Token[] =>
  line
    .replace(/[|]/g, ' | ')
    .split(/[\s:;]+/)
    .map((raw) => ({ raw, norm: normToken(raw), box: null, conf: null }))
    .filter((token) => !isPunctuation(token.norm) || token.norm === '/');

/** Agrupa palabras con caja en líneas por solapamiento vertical; así una columna de etiquetas y otra de valores
 * a la misma altura quedan en la misma línea aunque Vision las devuelva en bloques distintos. */
const linesFromWords = (words: OcrWord[]): Line[] => {
  const boxed = words.filter((word) => word.box && String(word.text || '').trim());
  const sorted = [...boxed].sort((a, b) => (a.box!.y + a.box!.height / 2) - (b.box!.y + b.box!.height / 2));
  const lines: Array<{ center: number; height: number; tokens: Token[] }> = [];
  for (const word of sorted) {
    const box = word.box!;
    const center = box.y + box.height / 2;
    const line = lines.find((item) => Math.abs(item.center - center) <= Math.min(item.height, box.height) * 0.55);
    const token = { raw: word.text, norm: normToken(word.text), box, conf: typeof word.confidence === 'number' ? word.confidence : null };
    if (isPunctuation(token.norm) && token.norm !== '/') continue;
    if (line) {
      line.tokens.push(token);
      line.center = (line.center * (line.tokens.length - 1) + center) / line.tokens.length;
    } else {
      lines.push({ center, height: box.height, tokens: [token] });
    }
  }
  return lines
    .sort((a, b) => a.center - b.center)
    .map((line) => ({ tokens: line.tokens.sort((a, b) => a.box!.x - b.box!.x) }));
};

export function buildLines(pass: OcrPass): Line[] {
  const words = pass.words || [];
  const boxed = words.filter((word) => word.box).length;
  if (words.length && boxed >= words.length / 2) return linesFromWords(words);
  return String(pass.text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => ({ tokens: tokensFromText(line) }))
    .filter((line) => line.tokens.length);
}

// ---------------- Etiquetas ----------------

const componentNear = (tokens: Token[], start: number, end: number): SerialComponent => {
  for (const index of [start - 2, start - 1, end, end + 1]) {
    const component = COMPONENT_WORDS[tokens[index]?.norm || ''];
    if (component) return component;
  }
  return null;
};

export function matchLabel(tokens: Token[], index: number): LabelMatch | null {
  const t = tokens[index]?.norm || '';
  const n1 = tokens[index + 1]?.norm || '';
  const n2 = tokens[index + 2]?.norm || '';
  const imei = /^(?:IMEI|1MEI|LMEI|IME1)(?:\/MEID)?([12])?$/.exec(t);
  if (imei) {
    if (imei[1]) return { type: 'imei', length: 1, text: t, slot: imei[1] === '2' ? 'imei2' : 'imei1' };
    if (/^\(?[12]\)?$/.test(n1)) return { type: 'imei', length: 2, text: `${t} ${n1}`, slot: n1.includes('2') ? 'imei2' : 'imei1' };
    if (n1 === '/' && n2 === 'MEID') return { type: 'imei', length: 3, text: 'IMEI/MEID', slot: 'plain' };
    return { type: 'imei', length: 1, text: t, slot: 'plain' };
  }
  if (t === 'S/N' || t === 'SN') return { type: 'serial', length: 1, text: t };
  if (t === 'S' && n1 === '/' && n2 === 'N') return { type: 'serial', length: 3, text: 'S/N' };
  if ((t === 'S' && n1 === '/N') || (t === 'S/' && n1 === 'N')) return { type: 'serial', length: 2, text: 'S/N' };
  if (t === 'SERIALNO' || t === 'SERIALNUMBER') return { type: 'serial', length: 1, text: t };
  if (t === 'SERIAL') {
    if (SERIAL_SUFFIXES.has(n1)) return { type: 'serial', length: 2, text: `SERIAL ${n1}` };
    return { type: 'serial', length: 1, text: t };
  }
  if (NUMBER_WORDS.has(t)) {
    if (n1 === 'SERIE') return { type: 'serial', length: 2, text: `${t} SERIE` };
    if (n1 === 'DE' && n2 === 'SERIE') return { type: 'serial', length: 3, text: `${t} DE SERIE` };
  }
  if (t === 'SERIE') return { type: 'serial', length: 1, text: t };
  if (t === 'MEID') return { type: 'negative', length: 1, text: t };
  if (t === 'P' && n1 === '/' && n2 === 'N') return { type: 'negative', length: 3, text: 'P/N' };
  if (NEGATIVE_LABELS.has(t)) {
    const length = ['NO', 'NUMBER', 'NUM', 'ID', '#'].includes(n1) ? 2 : 1;
    return { type: 'negative', length, text: t };
  }
  return null;
}

const findLabels = (lines: Line[]): LabelHit[] => {
  const hits: LabelHit[] = [];
  lines.forEach((line, lineIndex) => {
    for (let index = 0; index < line.tokens.length; index += 1) {
      const match = matchLabel(line.tokens, index);
      if (!match) continue;
      const end = index + match.length;
      const component = match.type === 'serial' ? componentNear(line.tokens, index, end) : null;
      hits.push({ ...match, component, line: lineIndex, start: index, end, box: unionBoxes(line.tokens.slice(index, end).map((t) => t.box)) });
      index = end - 1;
    }
  });
  return hits;
};

// ---------------- Valores ----------------

const isComponentWord = (token: Token) => Boolean(COMPONENT_WORDS[token.norm]);

/** Tokens de valor de una etiqueta en su propia línea: desde el final de la etiqueta hasta la siguiente. */
const valueTokensSameLine = (lines: Line[], hit: LabelHit, hits: LabelHit[]) => {
  const next = hits.filter((other) => other.line === hit.line && other.start >= hit.end).sort((a, b) => a.start - b.start)[0];
  return lines[hit.line].tokens.slice(hit.end, next ? next.start : undefined).filter((token) => !isComponentWord(token));
};

const lineHasLabels = (hits: LabelHit[], line: number) => hits.some((hit) => hit.line === line);
const lineIsOnlyLabels = (lines: Line[], hits: LabelHit[], line: number) => {
  const own = hits.filter((hit) => hit.line === line);
  if (!own.length) return false;
  const covered = new Set<number>();
  own.forEach((hit) => { for (let i = hit.start; i < hit.end; i += 1) covered.add(i); });
  return lines[line].tokens.every((token, index) => covered.has(index) || isComponentWord(token));
};

const serialShape = (value: string) => /^[A-Z0-9]{8,14}$/.test(value) && !SERIAL_STOP_WORDS.has(value);
const vowelCount = (value: string) => (value.match(/[AEIOU]/g) || []).length;

type ValuePick = { tokens: Token[]; value: string; raw: string; joined: boolean };

const pickSerial = (tokens: Token[]): ValuePick | null => {
  for (let index = 0; index < Math.min(tokens.length, 3); index += 1) {
    const token = tokens[index];
    if (/[/\-:]/.test(token.norm)) return null; // números de pieza (MGJ53LL/A), regulatorios (BCG-E3091A), MAC
    if (serialShape(token.norm)) return { tokens: [token], value: token.norm, raw: token.raw, joined: false };
    const next = tokens[index + 1];
    if (next && /^[A-Z0-9]{3,9}$/.test(token.norm) && /^[A-Z0-9]{3,9}$/.test(next.norm)) {
      const value = token.norm + next.norm;
      if (value.length >= 10 && value.length <= 12 && serialShape(value)) {
        return { tokens: [token, next], value, raw: `${token.raw} ${next.raw}`, joined: true };
      }
    }
    if (token.norm.length > 3) return null; // el primer token largo no es un serial: no buscar más allá
  }
  return null;
};

type DigitRun = { tokens: Token[]; raw: string; value: string; corrections: IdentifierCorrection[] };

const digitTokenCorrections = (norm: string, allowAmbiguous: boolean) => {
  const compact = norm.replace(/[.\-]/g, '');
  if (/^\d+$/.test(compact)) return { digits: compact, corrections: [] as IdentifierCorrection[] };
  if (!allowAmbiguous) return null;
  const digitShare = (compact.match(/\d/g) || []).length / Math.max(1, compact.length);
  if (digitShare < 0.6) return null;
  const corrections: IdentifierCorrection[] = [];
  let digits = '';
  for (const char of compact) {
    if (/\d/.test(char)) digits += char;
    else if (AMBIGUOUS_DIGITS[char]) {
      corrections.push({ index: digits.length, from: char, to: AMBIGUOUS_DIGITS[char], reason: 'Carácter confundible en un IMEI etiquetado' });
      digits += AMBIGUOUS_DIGITS[char];
    } else return null;
  }
  return { digits, corrections };
};

/** Agrupa tokens numéricos contiguos en IMEIs de exactamente 15 dígitos, solo en límites de token.
 * Un bloque que no encaja (EID de 32, ICCID de 19-20, MEID de 14) se descarta sin recortarlo. */
const pickImeis = (tokens: Token[], allowAmbiguous: boolean): DigitRun[] => {
  const parts: Array<{ token: Token; digits: string; corrections: IdentifierCorrection[] }> = [];
  for (const token of tokens) {
    const parsed = digitTokenCorrections(token.norm, allowAmbiguous);
    if (!parsed) break;
    parts.push({ token, ...parsed });
  }
  const runs: DigitRun[] = [];
  let current: typeof parts = [];
  let length = 0;
  for (const part of parts) {
    current.push(part);
    length += part.digits.length;
    if (length === 15) {
      let offset = 0;
      const corrections: IdentifierCorrection[] = [];
      current.forEach((item) => {
        item.corrections.forEach((c) => corrections.push({ ...c, index: c.index + offset }));
        offset += item.digits.length;
      });
      runs.push({
        tokens: current.map((item) => item.token),
        raw: current.map((item) => item.token.raw).join(' '),
        value: current.map((item) => item.digits).join(''),
        corrections,
      });
      current = [];
      length = 0;
    } else if (length > 15) {
      return runs.length ? runs : [];
    }
  }
  return current.length ? (runs.length ? runs : []) : runs;
};

// ---------------- Candidatos ----------------

const SERIAL_BASE: Record<LabelEvidence, number> = { same_line: 0.82, previous_line: 0.72, column: 0.66, none: 0.3 };

const serialValidation = (value: string): IdentifierValidation => {
  const normalized = normalizeSerial(value);
  if (normalized.error) return { status: 'invalid', rule: 'apple_serial', message: normalized.error };
  if (value.length < 10 || value.length > 12) {
    return { status: 'review', rule: 'apple_serial', message: 'Longitud atípica para un serial Apple (10 a 12).' };
  }
  return { status: 'valid', rule: 'apple_serial' };
};

const withVision = (base: number, tokens: Token[]) => {
  const vc = visionConfidence(tokens);
  return {
    confidence: clamp01(vc === null ? base : base * (0.6 + 0.4 * vc)),
    confidenceSource: (vc === null ? 'heuristic' : 'heuristic+vision') as IdentifierCandidate['confidenceSource'],
  };
};

const serialDrafts = (pick: ValuePick, evidence: LabelEvidence, hit: LabelHit | null, passId: string, order: number): Draft[] => {
  const value = pick.value;
  const lettersOnly = /^[A-Z]+$/.test(value);
  const hasLetter = /[A-Z]/.test(value);
  if (!hasLetter) return [];
  if (lettersOnly) {
    // Un serial solo de letras exige etiqueta, longitud Apple y no parecer una palabra.
    if (evidence === 'none' || value.length < 10 || value.length > 12 || vowelCount(value) >= 2) return [];
  }
  if (evidence === 'none' && (/^[0-9A-F]{12}$/.test(value) || value.length < 10 || value.length > 12)) return [];
  const warnings: string[] = [];
  let base = SERIAL_BASE[evidence];
  if (evidence === 'none') warnings.push('no_label');
  if (evidence === 'column') warnings.push('column_pairing');
  if (lettersOnly) { base -= 0.05; warnings.push('letters_only'); }
  if (pick.joined) { base -= 0.1; warnings.push('joined_tokens'); }
  const validation = serialValidation(value);
  if (validation.status !== 'valid') base -= 0.2;
  const ambiguous = !lettersOnly && /[OI]/.test(value);
  if (ambiguous) { base -= 0.2; warnings.push('ambiguous_characters'); }
  const common = {
    kind: 'serial' as const,
    rawValue: pick.raw,
    label: hit?.text || null,
    slot: null,
    component: hit?.component || null,
    labelEvidence: evidence,
    sourcePass: passId,
    boundingBox: unionBoxes(pick.tokens.map((token) => token.box)),
    order,
  };
  const drafts: Draft[] = [{ ...common, ...withVision(base, pick.tokens), value, validation, warnings, corrections: [] }];
  if (ambiguous) {
    // Alternativa justificada: en un serial mixto, O/0 e I/1 se confunden en OCR. Se ofrece aparte y con procedencia.
    const corrections: IdentifierCorrection[] = [];
    const alternative = value.replace(/[OI]/g, (char, index: number) => {
      const to = char === 'O' ? '0' : '1';
      corrections.push({ index, from: char, to, reason: `${char}/${to} confundibles en un serial mixto` });
      return to;
    });
    drafts.push({
      ...common,
      ...withVision(base - 0.1, pick.tokens),
      value: alternative,
      validation: serialValidation(alternative),
      warnings: [...warnings.filter((w) => w !== 'ambiguous_characters'), 'alternative_reading'],
      corrections,
    });
  }
  return drafts;
};

const imeiDraft = (run: DigitRun, evidence: LabelEvidence, hit: LabelHit | null, slot: ImeiSlot, passId: string, order: number, extraWarnings: string[] = []): Draft => {
  const valid = !normalizeImei(run.value).error && luhnValid(run.value);
  const warnings = [...extraWarnings];
  let base = evidence === 'none' ? 0.55 : evidence === 'same_line' ? 0.95 : 0.9;
  if (!valid) { base = 0.35; warnings.push('luhn_invalid'); }
  if (run.corrections.length) { base -= 0.2; warnings.push('corrected_characters'); }
  if (evidence === 'none') warnings.push('no_label');
  if (evidence === 'column') warnings.push('column_pairing');
  return {
    kind: 'imei',
    value: run.value,
    rawValue: run.raw,
    label: hit?.text || null,
    slot,
    component: null,
    labelEvidence: evidence,
    ...withVision(base, run.tokens),
    validation: valid
      ? { status: 'valid', rule: 'luhn' }
      : { status: 'invalid', rule: 'luhn', message: 'No supera la comprobación Luhn: revisar antes de usar.' },
    warnings,
    sourcePass: passId,
    boundingBox: unionBoxes(run.tokens.map((token) => token.box)),
    corrections: run.corrections,
    order,
  };
};

const recognizePass = (pass: OcrPass, orderStart: number) => {
  const lines = buildLines(pass);
  const hits = findLabels(lines);
  const drafts: Draft[] = [];
  const labels: RecognitionResult['labels'] = [];
  const consumed = new Set<string>(); // "línea:token" ya usados por una etiqueta
  let order = orderStart;
  const markConsumed = (line: number, tokens: Token[]) => tokens.forEach((token) => consumed.add(`${line}:${lines[line].tokens.indexOf(token)}`));

  const explicitImei2 = hits.some((hit) => hit.type === 'imei' && hit.slot === 'imei2');
  const plainImeiValues: string[] = [];
  const slotFor = (hit: LabelHit, value: string): { slot: ImeiSlot; warnings: string[] } => {
    if (hit.slot === 'imei1' || hit.slot === 'imei2') return { slot: hit.slot, warnings: [] };
    if (!plainImeiValues.includes(value)) plainImeiValues.push(value);
    const position = plainImeiValues.indexOf(value);
    if (position === 0) return { slot: 'imei1', warnings: [] };
    if (position === 1 && !explicitImei2) return { slot: 'imei2', warnings: ['slot_inferred'] };
    return { slot: null, warnings: ['slot_unknown'] };
  };

  const emit = (hit: LabelHit, tokens: Token[], evidence: LabelEvidence, line: number) => {
    if (hit.type === 'serial') {
      const pick = pickSerial(tokens);
      if (!pick) return false;
      markConsumed(line, pick.tokens);
      drafts.push(...serialDrafts(pick, evidence, hit, pass.id, order++));
      return true;
    }
    if (hit.type === 'imei') {
      const runs = pickImeis(tokens, true);
      if (!runs.length) return false;
      runs.forEach((run, index) => {
        markConsumed(line, run.tokens);
        // Dos IMEI tras una sola etiqueta: el segundo es secundario solo si la etiqueta no fija la posición.
        const target = index === 0 ? slotFor(hit, run.value) : hit.slot === 'plain' ? slotFor({ ...hit }, run.value) : { slot: null, warnings: ['slot_unknown'] };
        drafts.push(imeiDraft(run, evidence, hit, target.slot, pass.id, order++, target.warnings));
      });
      return true;
    }
    // Etiqueta negativa (EID, ICCID, MEID, modelo, pedido...): sus valores no se reutilizan.
    markConsumed(line, tokens);
    return true;
  };

  // Columnas en texto plano: k líneas de solo etiquetas seguidas de k líneas de solo valores.
  const pairedByColumn = new Set<LabelHit>();
  for (let line = 0; line < lines.length; line += 1) {
    if (!lineIsOnlyLabels(lines, hits, line)) continue;
    let end = line;
    while (end + 1 < lines.length && lineIsOnlyLabels(lines, hits, end + 1)) end += 1;
    const count = end - line + 1;
    if (count >= 2) {
      const valueLines = Array.from({ length: count }, (_, i) => end + 1 + i);
      if (valueLines.every((valueLine) => valueLine < lines.length && !lineHasLabels(hits, valueLine))) {
        valueLines.forEach((valueLine, i) => {
          const labelHits = hits.filter((hit) => hit.line === line + i);
          const hit = labelHits[labelHits.length - 1];
          if (emit(hit, lines[valueLine].tokens, 'column', valueLine)) pairedByColumn.add(hit);
          labelHits.forEach((h) => pairedByColumn.add(h));
        });
      }
    }
    line = end;
  }

  for (const hit of hits) {
    if (pairedByColumn.has(hit)) {
      if (hit.type !== 'negative') labels.push({ type: hit.type, passId: pass.id, box: hit.box, hasValue: true });
      continue;
    }
    let found = false;
    const same = valueTokensSameLine(lines, hit, hits);
    if (same.length) found = emit(hit, same, 'same_line', hit.line);
    else if (hit.line + 1 < lines.length) {
      // Etiqueta sin valor a su derecha: buscar en la línea siguiente, antes de cualquier otra etiqueta
      // y, si hay cajas, solo bajo o a la derecha de la etiqueta.
      const nextLine = hit.line + 1;
      const firstLabel = hits.filter((h) => h.line === nextLine).sort((a, b) => a.start - b.start)[0];
      let tokens = lines[nextLine].tokens.slice(0, firstLabel ? firstLabel.start : undefined);
      if (hit.box) tokens = tokens.filter((token) => !token.box || token.box.x + token.box.width >= hit.box!.x - hit.box!.width);
      if (tokens.length) found = emit(hit, tokens, 'previous_line', nextLine);
    }
    if (hit.type !== 'negative') labels.push({ type: hit.type, passId: pass.id, box: hit.box, hasValue: found });
  }

  // Sin etiqueta: solo IMEI de 15 dígitos con Luhn válido y seriales mixtos; nunca dentro de una zona negativa.
  lines.forEach((line, lineIndex) => {
    const negativeStarts = hits.filter((hit) => hit.line === lineIndex && hit.type === 'negative').map((hit) => hit.start);
    const firstNegative = negativeStarts.length ? Math.min(...negativeStarts) : Infinity;
    line.tokens.forEach((token, index) => {
      if (consumed.has(`${lineIndex}:${index}`) || index >= firstNegative) return;
      if (hits.some((hit) => hit.line === lineIndex && index >= hit.start && index < hit.end)) return;
      if (/^\d{15}$/.test(token.norm) && luhnValid(token.norm)) {
        drafts.push(imeiDraft({ tokens: [token], raw: token.raw, value: token.norm, corrections: [] }, 'none', null, null, pass.id, order++));
      } else if (/^[A-Z0-9]{10,12}$/.test(token.norm) && /\d/.test(token.norm) && /[A-Z]/.test(token.norm)) {
        drafts.push(...serialDrafts({ tokens: [token], value: token.norm, raw: token.raw, joined: false }, 'none', null, pass.id, order++));
      }
    });
  });

  return { drafts, labels, order };
};

// ---------------- Fusión y decisión ----------------

export function recognizeIdentifiers(passes: OcrPass[]): RecognitionResult {
  const allDrafts: Draft[] = [];
  const labels: RecognitionResult['labels'] = [];
  let order = 0;
  for (const pass of passes) {
    const result = recognizePass(pass, order);
    order = result.order;
    allDrafts.push(...result.drafts);
    labels.push(...result.labels);
  }

  // Un mismo valor con etiqueta descarta sus lecturas sin etiqueta.
  const labelled = new Set(allDrafts.filter((d) => d.labelEvidence !== 'none').map((d) => `${d.kind}:${d.value}`));
  const drafts = allDrafts.filter((d) => d.labelEvidence !== 'none' || !labelled.has(`${d.kind}:${d.value}`));

  const merged = new Map<string, IdentifierCandidate & { order: number }>();
  for (const draft of drafts) {
    const key = `${draft.kind}:${draft.value}:${draft.slot || ''}:${draft.component || ''}`;
    const existing = merged.get(key);
    if (!existing) {
      const { order: draftOrder, ...rest } = draft;
      merged.set(key, { ...rest, id: key, sourcePasses: [draft.sourcePass], autofill: false, order: draftOrder });
      continue;
    }
    if (!existing.sourcePasses.includes(draft.sourcePass)) existing.sourcePasses.push(draft.sourcePass);
    if (draft.confidence > existing.confidence) {
      Object.assign(existing, { ...draft, id: key, sourcePasses: existing.sourcePasses, autofill: false, order: existing.order });
    }
    if (!existing.boundingBox && draft.boundingBox) existing.boundingBox = draft.boundingBox;
  }
  const candidates = Array.from(merged.values());
  const conflicts: IdentifierConflict[] = [];

  // IMEI: mismo valor en IMEI 1 e IMEI 2, o dos valores válidos distintos para la misma posición.
  const imeis = candidates.filter((c) => c.kind === 'imei');
  for (const value of new Set(imeis.map((c) => c.value))) {
    const slots = new Set(imeis.filter((c) => c.value === value && c.slot).map((c) => c.slot));
    if (slots.size > 1) {
      conflicts.push({ type: 'same_value_both_slots', values: [value] });
      imeis.filter((c) => c.value === value).forEach((c) => c.warnings.push('same_value_both_slots'));
    }
  }
  const autofillImei = (c: IdentifierCandidate) =>
    c.labelEvidence !== 'none' && c.slot !== null && c.validation.status === 'valid' && !c.corrections.length &&
    !c.warnings.includes('same_value_both_slots') && !c.warnings.includes('slot_inferred') && c.confidence >= AUTOFILL_MIN_CONFIDENCE;
  for (const slot of ['imei1', 'imei2'] as const) {
    const eligible = imeis.filter((c) => c.slot === slot && autofillImei(c));
    const values = Array.from(new Set(imeis.filter((c) => c.slot === slot && c.validation.status === 'valid').map((c) => c.value)));
    if (values.length > 1) {
      conflicts.push({ type: 'slot_conflict', slot, values });
      imeis.filter((c) => c.slot === slot).forEach((c) => c.warnings.push('slot_conflict'));
    } else if (eligible.length === 1) eligible[0].autofill = true;
  }

  // Serial: un único valor etiquetado y limpio para el equipo (o el estuche, en AirPods).
  const serials = candidates.filter((c) => c.kind === 'serial');
  const autofillSerial = (c: IdentifierCandidate) =>
    c.labelEvidence !== 'none' && c.validation.status === 'valid' && c.confidence >= AUTOFILL_MIN_CONFIDENCE &&
    !c.corrections.length && !c.warnings.includes('ambiguous_characters') && !c.warnings.includes('joined_tokens');
  for (const component of [null, 'case', 'left', 'right'] as SerialComponent[]) {
    const group = serials.filter((c) => c.component === component && c.labelEvidence !== 'none' && !c.corrections.length);
    const values = Array.from(new Set(group.map((c) => c.value)));
    if (values.length > 1) {
      conflicts.push({ type: 'serial_conflict', component, values });
      group.forEach((c) => c.warnings.push('serial_conflict'));
    }
  }
  const mainSerials = Array.from(new Set(serials.filter((c) => (c.component === null || c.component === 'case') && autofillSerial(c) && !c.warnings.includes('serial_conflict')).map((c) => c.value)));
  if (mainSerials.length === 1) {
    serials.filter((c) => c.value === mainSerials[0] && (c.component === null || c.component === 'case')).forEach((c) => { c.autofill = true; });
  } else if (mainSerials.length > 1) {
    conflicts.push({ type: 'serial_conflict', component: null, values: mainSerials });
  }

  candidates.forEach((c) => { c.confidence = round(c.confidence); c.warnings = Array.from(new Set(c.warnings)); });
  candidates.sort((a, b) => Number(b.autofill) - Number(a.autofill) || b.confidence - a.confidence || a.order - b.order);
  const output = candidates.map(({ order: _order, ...candidate }) => candidate);

  const pickAuto = (predicate: (c: IdentifierCandidate) => boolean) => output.find((c) => c.autofill && predicate(c))?.value || '';
  const imei1 = pickAuto((c) => c.kind === 'imei' && c.slot === 'imei1');
  const imei2 = pickAuto((c) => c.kind === 'imei' && c.slot === 'imei2');
  const validImeis = output.filter((c) => c.kind === 'imei' && c.validation.status === 'valid').map((c) => c.value);
  return {
    candidates: output,
    conflicts,
    serial: pickAuto((c) => c.kind === 'serial'),
    imei1,
    imei2,
    serials: Array.from(new Set(output.filter((c) => c.kind === 'serial').map((c) => c.value))),
    imeis: Array.from(new Set([imei1, imei2, ...validImeis].filter(Boolean))),
    labels,
  };
}

/** Atajo para texto plano (sin cajas), útil en pruebas y para URLs sin geometría. */
export const recognizeText = (text: string, passId = 'full') => recognizeIdentifiers([{ id: passId, kind: 'full', text }]);
