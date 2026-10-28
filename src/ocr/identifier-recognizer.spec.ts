import { luhnValid, recognizeIdentifiers, recognizeText } from './identifier-recognizer';

// Fixtures sintéticos: ningún valor corresponde a un equipo real.
const withLuhn = (body14: string) => {
  for (let check = 0; check <= 9; check += 1) if (luhnValid(`${body14}${check}`)) return `${body14}${check}`;
  throw new Error('sin dígito');
};
const IMEI_A = withLuhn('35209900176148');
const IMEI_B = withLuhn('35391511234567');
const IMEI_ZERO = withLuhn('01234567890123');
const breakLuhn = (imei: string) => `${imei.slice(0, 14)}${(Number(imei[14]) + 1) % 10}`;

const serialCandidates = (text: string) => recognizeText(text).candidates.filter((c) => c.kind === 'serial');

describe('seriales', () => {
  test('serial solo de letras con etiqueta en la misma línea (fallo original)', () => {
    const result = recognizeText('Serial Number: FGHJKLMPQR');
    expect(result.serial).toBe('FGHJKLMPQR');
    const [candidate] = result.candidates;
    expect(candidate).toMatchObject({ kind: 'serial', value: 'FGHJKLMPQR', rawValue: 'FGHJKLMPQR', labelEvidence: 'same_line', autofill: true });
    expect(candidate.validation.status).toBe('valid');
    expect(candidate.warnings).toContain('letters_only');
  });

  test('serial mixto y variantes de etiqueta (S/N, Serial No., número de serie)', () => {
    expect(recognizeText('S/N: C02XG2JHJGH5').serial).toBe('C02XG2JHJGH5');
    expect(recognizeText('(S) Serial No. DMPXL7HJKPHC').serial).toBe('DMPXL7HJKPHC');
    expect(recognizeText('Número de serie GXQTQJCTWH').serial).toBe('GXQTQJCTWH');
    expect(recognizeText('S / N  H4GDK9PQRSTV').serial).toBe('H4GDK9PQRSTV');
  });

  test('una palabra sin etiqueta no se autocompleta ni se lista', () => {
    const result = recognizeText('FGHJKLMPQR\nModel A2172');
    expect(result.serial).toBe('');
    expect(serialCandidates('FGHJKLMPQR')).toHaveLength(0);
  });

  test('un serial mixto sin etiqueta se lista, pero no se autocompleta', () => {
    const result = recognizeText('C02XG2JHJGH5');
    expect(result.serial).toBe('');
    expect(result.candidates[0]).toMatchObject({ value: 'C02XG2JHJGH5', labelEvidence: 'none', autofill: false });
    expect(result.candidates[0].warnings).toContain('no_label');
  });

  test('letras ambiguas: sin sustitución global, alternativa aparte con procedencia', () => {
    const result = recognizeText('Serial No. C02XO2JHJGH5');
    expect(result.serial).toBe('');
    const raw = result.candidates.find((c) => c.value === 'C02XO2JHJGH5');
    const alt = result.candidates.find((c) => c.value === 'C02X02JHJGH5');
    expect(raw?.warnings).toContain('ambiguous_characters');
    expect(raw?.corrections).toEqual([]);
    expect(alt?.corrections).toEqual([{ index: 4, from: 'O', to: '0', reason: expect.any(String) }]);
    expect(alt?.warnings).toContain('alternative_reading');
    expect(alt?.autofill).toBe(false);
    // Un serial solo de letras con L o I no se convierte en dígitos.
    expect(recognizeText('Serial: FGHJKLLPQR').serial).toBe('FGHJKLLPQR');
  });

  test('falsos positivos comerciales y regulatorios', () => {
    const text = [
      'Designed by Apple in California Assembled in China',
      'Model A2172  EMC 3436',
      'Part No. MGJ53LL/A',
      'Order No. W1234567890',
      'Wi-Fi Address A4B1C2D3E4F5',
      'MAC 3C:22:FB:12:34:56',
      'UPC 194252034570',
      'FCC ID: BCG-E3091A  IC: 579C-E3091A',
      'CMIIT ID: 2019AP1234',
      `EID 89049032005008882600012345678901`,
      'ICCID 8901410321111851072',
    ].join('\n');
    const result = recognizeText(text);
    expect(result.candidates).toEqual([]);
    expect(result.serial).toBe('');
    expect(result.imeis).toEqual([]);
  });

  test('etiqueta en la línea anterior', () => {
    const result = recognizeText('Serial Number\nFGHJKLMPQR');
    expect(result.serial).toBe('FGHJKLMPQR');
    expect(result.candidates[0].labelEvidence).toBe('previous_line');
  });

  test('dos columnas en texto plano: etiquetas y luego valores', () => {
    const result = recognizeText(['Serial No.', 'IMEI', 'IMEI2', 'FGHJKLMPQR', IMEI_A, IMEI_B].join('\n'));
    expect(result).toMatchObject({ serial: 'FGHJKLMPQR', imei1: IMEI_A, imei2: IMEI_B });
    expect(result.candidates.every((c) => c.labelEvidence === 'column')).toBe(true);
  });

  test('dos columnas con cajas: la geometría une etiqueta y valor a la misma altura', () => {
    const word = (text: string, x: number, y: number) => ({ text, box: { x, y, width: text.length * 10, height: 20 }, confidence: 0.98 });
    const result = recognizeIdentifiers([{
      id: 'full',
      kind: 'full',
      words: [
        word('Serial', 10, 100), word('No.', 80, 101),
        word('IMEI', 10, 140),
        word('FGHJKLMPQR', 400, 102),
        word(IMEI_A, 400, 141),
      ],
    }]);
    expect(result.serial).toBe('FGHJKLMPQR');
    expect(result.imei1).toBe(IMEI_A);
    const serial = result.candidates.find((c) => c.kind === 'serial')!;
    expect(serial.boundingBox).toEqual({ x: 400, y: 102, width: 100, height: 20 });
    expect(serial.confidenceSource).toBe('heuristic+vision');
  });

  test('AirPods: serial del estuche distinto de los auriculares', () => {
    const result = recognizeText('Case Serial Number: GXQTQJCTWH\nLeft Serial Number: HKLMNPQRST\nRight Serial Number: JKLMNPQRSV');
    expect(result.serial).toBe('GXQTQJCTWH');
    const byComponent = Object.fromEntries(result.candidates.map((c) => [c.component, c.value]));
    expect(byComponent).toEqual({ case: 'GXQTQJCTWH', left: 'HKLMNPQRST', right: 'JKLMNPQRSV' });
    expect(result.candidates.filter((c) => c.autofill).map((c) => c.component)).toEqual(['case']);
  });

  test('dos seriales etiquetados distintos generan conflicto y ninguno se autocompleta', () => {
    const result = recognizeText('Serial: FGHJKLMPQR\nS/N: C02XG2JHJGH5');
    expect(result.serial).toBe('');
    expect(result.conflicts).toEqual([{ type: 'serial_conflict', component: null, values: ['FGHJKLMPQR', 'C02XG2JHJGH5'] }]);
  });
});

describe('IMEI', () => {
  test('etiquetas en orden inverso se respetan', () => {
    const result = recognizeText(`IMEI2 ${IMEI_B}\nIMEI ${IMEI_A}`);
    expect(result.imei1).toBe(IMEI_A);
    expect(result.imei2).toBe(IMEI_B);
    expect(result.imeis).toEqual([IMEI_A, IMEI_B]);
  });

  test('solo IMEI2: no se mueve a IMEI 1', () => {
    const result = recognizeText(`IMEI 2: ${IMEI_B}`);
    expect(result.imei1).toBe('');
    expect(result.imei2).toBe(IMEI_B);
  });

  test('duplicados entre pasadas se fusionan y conservan la procedencia', () => {
    const result = recognizeIdentifiers([
      { id: 'full', kind: 'full', text: `IMEI ${IMEI_A}` },
      { id: 'zoom-1', kind: 'zoom', text: `IMEI: ${IMEI_A}` },
    ]);
    const imeis = result.candidates.filter((c) => c.kind === 'imei');
    expect(imeis).toHaveLength(1);
    expect(imeis[0].sourcePasses).toEqual(['full', 'zoom-1']);
    expect(result.imei1).toBe(IMEI_A);
  });

  test('mismo valor en IMEI e IMEI2 es un conflicto', () => {
    const result = recognizeText(`IMEI ${IMEI_A}\nIMEI2 ${IMEI_A}`);
    expect(result.imei1).toBe('');
    expect(result.imei2).toBe('');
    expect(result.conflicts[0]).toEqual({ type: 'same_value_both_slots', values: [IMEI_A] });
  });

  test('ceros iniciales se conservan como texto y IMEI con espacios', () => {
    expect(recognizeText(`IMEI ${IMEI_ZERO}`).imei1).toBe(IMEI_ZERO);
    const spaced = `${IMEI_A.slice(0, 2)} ${IMEI_A.slice(2, 8)} ${IMEI_A.slice(8, 14)} ${IMEI_A.slice(14)}`;
    expect(recognizeText(`IMEI/MEID ${spaced}`).imei1).toBe(IMEI_A);
  });

  test('EID, ICCID y MEID no se recortan para fabricar un IMEI', () => {
    const eid = `${IMEI_A}${IMEI_B}01`;
    const result = recognizeText([
      `EID ${eid}`,
      `ICCID ${IMEI_A}1234`,
      `MEID ${IMEI_A.slice(0, 14)}`,
      `IMEI ${IMEI_A}12345`,
      eid,
    ].join('\n'));
    expect(result.candidates.filter((c) => c.kind === 'imei')).toEqual([]);
    expect(result.imeis).toEqual([]);
  });

  test('Luhn inválido se muestra para revisión, sin autocompletar', () => {
    const bad = breakLuhn(IMEI_A);
    const result = recognizeText(`IMEI ${bad}`);
    expect(result.imei1).toBe('');
    expect(result.imeis).toEqual([]);
    expect(result.candidates[0]).toMatchObject({ value: bad, slot: 'imei1', autofill: false, validation: { status: 'invalid', rule: 'luhn' } });
    expect(result.candidates[0].warnings).toContain('luhn_invalid');
    // Sin etiqueta y con Luhn inválido no se considera.
    expect(recognizeText(bad).candidates).toEqual([]);
  });

  test('carácter confundible dentro de un IMEI etiquetado se corrige con procedencia y queda en revisión', () => {
    const read = `${IMEI_A.slice(0, 6)}O${IMEI_A.slice(7)}`;
    if (IMEI_A[6] !== '0') throw new Error('fixture');
    const result = recognizeText(`IMEI ${read}`);
    expect(result.imei1).toBe('');
    expect(result.candidates[0]).toMatchObject({ value: IMEI_A, rawValue: read, corrections: [{ index: 6, from: 'O', to: '0', reason: expect.any(String) }] });
  });

  test('IMEI sin etiqueta y Luhn válido: candidato sin posición', () => {
    const result = recognizeText(`Algo\n${IMEI_A}`);
    expect(result.imei1).toBe('');
    expect(result.imeis).toEqual([IMEI_A]);
    expect(result.candidates[0]).toMatchObject({ slot: null, autofill: false, labelEvidence: 'none' });
  });
});

test('caja de iPhone completa', () => {
  const result = recognizeText([
    'iPhone 15 Pro 256GB Natural Titanium',
    'Designed by Apple in California Assembled in China',
    '(S) Serial No. FGHJKLMPQR',
    `IMEI/MEID ${IMEI_A}`,
    `IMEI2 ${IMEI_B}`,
    'Model A2848  Part No. MTV13LL/A',
    'EID 89049032005008882600012345678901',
  ].join('\n'));
  expect(result).toMatchObject({ serial: 'FGHJKLMPQR', imei1: IMEI_A, imei2: IMEI_B, serials: ['FGHJKLMPQR'], imeis: [IMEI_A, IMEI_B] });
  expect(result.conflicts).toEqual([]);
});
