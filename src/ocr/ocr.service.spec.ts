import { Logger } from '@nestjs/common';
import sharp = require('sharp');
import { OcrService } from './ocr.service';

// Sin red: fetch se sustituye por respuestas sintéticas de Cloud Vision; sharp es real.
type FakeWord = { text: string; x: number; y: number; w: number; h: number };
const visionResponse = (text: string, words: FakeWord[] = [], page = { width: 1000, height: 800 }) => ({
  responses: [{
    fullTextAnnotation: {
      text,
      pages: [{
        ...page,
        blocks: [{
          paragraphs: [{
            words: words.map((word) => ({
              confidence: 0.97,
              symbols: word.text.split('').map((char) => ({ text: char })),
              boundingBox: { vertices: [
                { x: word.x, y: word.y }, { x: word.x + word.w, y: word.y },
                { x: word.x + word.w, y: word.y + word.h }, { x: word.x, y: word.y + word.h },
              ] },
            })),
          }],
        }],
      }],
    },
  }],
});

const config = (values: Record<string, string> = {}) => ({
  get: (key: string) => ({ GOOGLE_CLOUD_VISION_API_KEY: 'test-key', ...values } as Record<string, string>)[key],
});

const makeImage = async (width = 1000, height = 800, orientation?: number) => {
  const base = sharp({ create: { width, height, channels: 3, background: { r: 240, g: 240, b: 240 } } });
  return (orientation ? base.withMetadata({ orientation }) : base).jpeg().toBuffer();
};

const mockFetch = (responses: unknown[]) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return { fn, calls };
};

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('imagen', () => {
  test('aplica la orientación EXIF antes de calcular coordenadas', async () => {
    const service = new OcrService(config() as any);
    const source = await makeImage(400, 200, 6);
    const prepared = await service.prepareImage(source, 40_000_000);
    expect(prepared).toMatchObject({ width: 200, height: 400, orientation: 6 });
    const meta = await sharp(prepared.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([200, 400]);
    expect(meta.orientation ?? 1).toBe(1);
  });

  test('sin EXIF la imagen no se reprocesa ni se reduce', async () => {
    const service = new OcrService(config() as any);
    const source = await makeImage(3000, 2000);
    const prepared = await service.prepareImage(source, 40_000_000);
    expect(prepared.buffer).toBe(source);
    expect([prepared.width, prepared.height]).toEqual([3000, 2000]);
  });

  test('límite de memoria: rechaza imágenes con demasiados píxeles', async () => {
    const service = new OcrService(config() as any);
    await expect(service.prepareImage(await makeImage(2000, 1000), 1_000_000)).rejects.toMatchObject({ status: expect.any(Number) });
  });

  test('recorte escalado: las cajas de la pasada ampliada vuelven a coordenadas originales', async () => {
    const service = new OcrService(config() as any);
    const image = await service.prepareImage(await makeImage(1000, 800), 40_000_000);
    const region = service.regionFromFractions({ x: 0.1, y: 0.25, width: 0.2, height: 0.05 }, image);
    expect(region).toEqual({ left: 100, top: 200, width: 200, height: 40 });
    const crop = await service.cropAndEnhance(image, region, { zoomMaxWidth: 800, zoomMaxPixels: 12_000_000 });
    const meta = await sharp(crop.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([800, 160]); // x4, nunca reducido
    const pass = service.toPass('manual', 'manual', visionResponse('SN FGHJKLMPQR', [
      { text: 'FGHJKLMPQR', x: 400, y: 40, w: 320, h: 80 },
    ], { width: 800, height: 160 }) as any, crop.region, image);
    expect(pass.words?.[0].box).toEqual({ x: 200, y: 210, width: 80, height: 20 });
  });

  test('cajas en el borde: la región se recorta a la imagen y sharp puede extraerla', async () => {
    const service = new OcrService(config() as any);
    const image = await service.prepareImage(await makeImage(600, 400), 40_000_000);
    const region = service.regionAroundLabel({ x: 560, y: 385, width: 40, height: 15 }, image);
    expect(region.left + region.width).toBeLessThanOrEqual(600);
    expect(region.top + region.height).toBeLessThanOrEqual(400);
    expect(region.width).toBeGreaterThan(0);
    const crop = await service.cropAndEnhance(image, { left: -50, top: 390, width: 900, height: 100 }, { zoomMaxWidth: 3200, zoomMaxPixels: 12_000_000 });
    expect(crop.region).toEqual({ left: 0, top: 390, width: 600, height: 10 });
    const meta = await sharp(crop.buffer).metadata();
    expect(meta.width).toBeGreaterThanOrEqual(600);
    const pass = service.toPass('zoom-1', 'zoom', visionResponse('x', [{ text: 'X', x: 2390, y: 30, w: 100, h: 20 }], { width: 2400, height: 40 }) as any, crop.region, image);
    const box = pass.words![0].box!;
    expect(box.x + box.width).toBeLessThanOrEqual(600);
    expect(box.y + box.height).toBeLessThanOrEqual(400);
  });
});

describe('detectText', () => {
  test('una sola llamada cuando la etiqueta ya respalda el serial; la clave no va en la URL', async () => {
    const service = new OcrService(config() as any);
    const { calls } = mockFetch([visionResponse('Serial Number: FGHJKLMPQR', [
      { text: 'Serial', x: 100, y: 100, w: 60, h: 20 }, { text: 'Number:', x: 170, y: 100, w: 70, h: 20 },
      { text: 'FGHJKLMPQR', x: 260, y: 100, w: 120, h: 20 },
    ])]);
    const result = await service.detectText({ imageBase64: (await makeImage()).toString('base64'), requestToken: 'tok-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain('key=');
    expect((calls[0].init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('test-key');
    expect(result).toMatchObject({ serial: 'FGHJKLMPQR', imei1: '', imei2: '', serials: ['FGHJKLMPQR'], imeis: [], calls: 1, requestToken: 'tok-1' });
    expect(result.budget.stoppedReason).toBe('satisfied');
    expect(result.text).toContain('FGHJKLMPQR');
    expect(result.candidates[0].boundingBox).toEqual({ x: 260, y: 100, width: 120, height: 20 });
  });

  test('imagen borrosa: un único reintento mejorado y se detiene', async () => {
    const service = new OcrService(config() as any);
    const { calls } = mockFetch([visionResponse(''), visionResponse('')]);
    const result = await service.detectText({ imageBase64: (await makeImage()).toString('base64') });
    expect(calls).toHaveLength(2);
    expect(result.passes.map((p) => p.kind)).toEqual(['full', 'enhanced']);
    expect(result.candidates).toEqual([]);
    expect(result.budget.stoppedReason).toBe('no_labels');
  });

  test('límite de reintentos: etiquetas sin valor nunca superan OCR_MAX_CALLS', async () => {
    const service = new OcrService(config({ OCR_MAX_CALLS: '2' }) as any);
    const labelsOnly = visionResponse('Serial No.\nIMEI\nIMEI2', [
      { text: 'Serial', x: 100, y: 100, w: 60, h: 20 },
      { text: 'IMEI', x: 100, y: 300, w: 50, h: 20 },
      { text: 'IMEI2', x: 100, y: 500, w: 60, h: 20 },
    ]);
    const { calls } = mockFetch([labelsOnly]);
    const result = await service.detectText({ imageBase64: (await makeImage()).toString('base64') });
    expect(calls).toHaveLength(2);
    expect(result.calls).toBe(2);
    expect(result.budget).toMatchObject({ maxCalls: 2, stoppedReason: 'budget' });
  });

  test('recorte manual: una llamada y cajas en coordenadas de la imagen original', async () => {
    const service = new OcrService(config() as any);
    const { calls } = mockFetch([visionResponse('S/N FGHJKLMPQR', [
      { text: 'S/N', x: 10, y: 10, w: 60, h: 40 }, { text: 'FGHJKLMPQR', x: 100, y: 10, w: 400, h: 40 },
    ], { width: 800, height: 160 })]);
    const result = await service.detectText({
      imageBase64: (await makeImage()).toString('base64'),
      crop: { x: 0.1, y: 0.25, width: 0.2, height: 0.05 },
    });
    expect(calls).toHaveLength(1);
    expect(result.serial).toBe('FGHJKLMPQR');
    expect(result.candidates[0].sourcePass).toBe('manual');
    expect(result.candidates[0].boundingBox).toEqual({ x: 125, y: 203, width: 100, height: 10 });
    expect(result.budget.stoppedReason).toBe('manual');
  });

  test('cancelación del cliente: no se lanzan más llamadas', async () => {
    const service = new OcrService(config() as any);
    const { calls } = mockFetch([visionResponse('')]);
    const controller = new AbortController();
    controller.abort();
    await expect(service.detectText({ imageBase64: (await makeImage()).toString('base64') }, controller.signal)).rejects.toMatchObject({ status: 499 });
    expect(calls).toHaveLength(0);
  });

  test('los registros no contienen texto, identificadores, imagen ni clave', async () => {
    const service = new OcrService(config() as any);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const ok = visionResponse('Serial No.', [{ text: 'Serial', x: 100, y: 100, w: 60, h: 20 }]);
    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      if (call === 1) return { ok: true, status: 200, json: async () => ok } as unknown as Response;
      return { ok: false, status: 500, json: async () => ({ error: { message: 'FGHJKLMPQR test-key' } }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const image = (await makeImage()).toString('base64');
    await service.detectText({ imageBase64: image });
    const logged = [...warn.mock.calls, ...log.mock.calls].flat().map(String).join('\n');
    expect(warn).toHaveBeenCalled();
    expect(logged).not.toMatch(/FGHJKLMPQR|test-key|Serial/);
    expect(logged).not.toContain(image.slice(0, 40));
  });
});
