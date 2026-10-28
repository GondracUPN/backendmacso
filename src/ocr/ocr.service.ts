import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp = require('sharp');
import { VisionOcrDto } from './dto/vision-ocr.dto';
import { OcrBox, OcrPass, OcrPassKind, OcrWord, recognizeIdentifiers, RecognitionResult } from './identifier-recognizer';

type Vertex = { x?: number; y?: number };
type BoundingPoly = { vertices?: Vertex[] };
type VisionWord = { symbols?: Array<{ text?: string }>; boundingBox?: BoundingPoly; confidence?: number };
type VisionPage = {
  width?: number;
  height?: number;
  blocks?: Array<{
    paragraphs?: Array<{
      words?: VisionWord[];
    }>;
  }>;
};
type VisionAnnotateResponse = {
  responses?: Array<{
    fullTextAnnotation?: {
      text?: string;
      pages?: VisionPage[];
    };
    textAnnotations?: Array<{ description?: string }>;
    error?: { message?: string };
  }>;
  error?: { message?: string };
};

type CropRegion = { left: number; top: number; width: number; height: number };

/** Imagen ya orientada (EXIF aplicado): todas las coordenadas del OCR se expresan en este sistema. */
type PreparedImage = { buffer: Buffer; width: number; height: number; orientation: number };

export type OcrBudget = {
  maxCalls: number;
  callTimeoutMs: number;
  totalTimeoutMs: number;
  maxPixels: number;
  zoomMaxWidth: number;
  zoomMaxPixels: number;
};

type PassSummary = { id: string; kind: OcrPassKind; ok: boolean; words: number; textLength: number };

const intFrom = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
};

export class OcrCancelledError extends Error {}

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);

  constructor(private readonly config: ConfigService) {}

  /** Presupuesto configurable: llamadas a Vision por solicitud, tiempo por llamada y total, y memoria (píxeles). */
  budget(): OcrBudget {
    const get = (key: string) => this.config.get<string>(key) ?? process.env[key];
    return {
      maxCalls: intFrom(get('OCR_MAX_CALLS'), 4, 1, 8),
      callTimeoutMs: intFrom(get('OCR_CALL_TIMEOUT_MS'), 12_000, 1_000, 60_000),
      totalTimeoutMs: intFrom(get('OCR_TOTAL_TIMEOUT_MS'), 25_000, 2_000, 120_000),
      maxPixels: intFrom(get('OCR_MAX_PIXELS'), 40_000_000, 1_000_000, 120_000_000),
      zoomMaxWidth: intFrom(get('OCR_ZOOM_MAX_WIDTH'), 3_200, 800, 6_000),
      zoomMaxPixels: intFrom(get('OCR_ZOOM_MAX_PIXELS'), 12_000_000, 1_000_000, 40_000_000),
    };
  }

  async detectText(input: VisionOcrDto, signal?: AbortSignal) {
    const apiKey =
      this.config.get<string>('GOOGLE_CLOUD_VISION_API_KEY') ||
      this.config.get<string>('GOOGLE_VISION_API_KEY') ||
      process.env.GOOGLE_CLOUD_VISION_API_KEY ||
      process.env.GOOGLE_VISION_API_KEY;

    if (!apiKey) {
      throw new HttpException(
        {
          message:
            'Falta configurar GOOGLE_CLOUD_VISION_API_KEY en el backend para usar Cloud Vision.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const budget = this.budget();
    const deadline = Date.now() + budget.totalTimeoutMs;
    const sourceBuffer = await this.resolveImageBuffer(input);
    const image = await this.prepareImage(sourceBuffer, budget.maxPixels);

    const passes: OcrPass[] = [];
    const summaries: PassSummary[] = [];
    const texts: Array<{ kind: OcrPassKind; text: string }> = [];
    let calls = 0;
    let stoppedReason: 'satisfied' | 'budget' | 'deadline' | 'cancelled' | 'no_labels' | 'manual' = 'satisfied';

    // Una pasada cuenta como llamada aunque falle; nunca se supera maxCalls ni el plazo total.
    const runPass = async (id: string, kind: OcrPassKind, region: CropRegion | null, enhance: boolean) => {
      if (signal?.aborted) { stoppedReason = 'cancelled'; return null; }
      if (calls >= budget.maxCalls) { stoppedReason = 'budget'; return null; }
      const remaining = deadline - Date.now();
      if (remaining < 1_000) { stoppedReason = 'deadline'; return null; }
      calls += 1;
      const prepared = region
        ? await this.cropAndEnhance(image, region, budget)
        : enhance
          ? { buffer: await this.enhance(image.buffer), region: { left: 0, top: 0, width: image.width, height: image.height } }
          : { buffer: image.buffer, region: { left: 0, top: 0, width: image.width, height: image.height } };
      const response = await this.annotateImage(apiKey, prepared.buffer.toString('base64'), Math.min(budget.callTimeoutMs, remaining), signal);
      const pass = this.toPass(id, kind, response, prepared.region, image);
      passes.push(pass);
      summaries.push({ id, kind, ok: true, words: pass.words?.length || 0, textLength: (pass.text || '').length });
      if (pass.text?.trim()) texts.push({ kind, text: pass.text });
      return pass;
    };
    const tryPass = async (id: string, kind: OcrPassKind, region: CropRegion | null, enhance: boolean) => {
      try {
        return await runPass(id, kind, region, enhance);
      } catch (error) {
        if (signal?.aborted || error instanceof OcrCancelledError) { stoppedReason = 'cancelled'; return null; }
        summaries.push({ id, kind, ok: false, words: 0, textLength: 0 });
        // Solo el tipo/estado del error: nunca texto, imagen, identificadores ni la clave.
        this.logger.warn(`Pasada OCR ${kind} fallida: ${error instanceof HttpException ? error.getStatus() : (error as Error)?.name || 'error'}`);
        return null;
      }
    };

    let recognition: RecognitionResult;
    if (input.crop) {
      // Recorte manual («Volver a leer esa zona»): fracciones de la imagen orientada, una sola llamada.
      const region = this.regionFromFractions(input.crop, image);
      await this.passOrThrow(() => runPass('manual', 'manual', region, true), signal);
      recognition = recognizeIdentifiers(passes);
      stoppedReason = signal?.aborted ? 'cancelled' : 'manual';
    } else {
      await this.passOrThrow(() => runPass('full', 'full', null, false), signal);
      recognition = recognizeIdentifiers(passes);

      if (!recognition.labels.length && (passes[0]?.text || '').replace(/\s/g, '').length < 12) {
        // Imagen borrosa o sin texto legible: un único reintento con contraste/nitidez moderados.
        await tryPass('enhanced', 'enhanced', null, true);
        recognition = recognizeIdentifiers(passes);
      }
      const regions = this.retryRegions(recognition, image);
      if (!regions.length && stoppedReason === 'satisfied' && !recognition.labels.length) stoppedReason = 'no_labels';
      for (const [index, region] of regions.entries()) {
        const pass = await tryPass(`zoom-${index + 1}`, 'zoom', region, true);
        if (!pass && ['budget', 'deadline', 'cancelled'].includes(stoppedReason)) break;
        recognition = recognizeIdentifiers(passes);
        if (this.isSatisfied(recognition)) { stoppedReason = 'satisfied'; break; }
      }
      if (regions.length && !this.isSatisfied(recognition) && stoppedReason === 'satisfied') stoppedReason = 'budget';
    }

    const zoomTexts = texts.filter((item) => item.kind !== 'full');
    const text = [
      texts.find((item) => item.kind === 'full')?.text || '',
      ...zoomTexts.map((item, index) => `--- ${item.kind === 'manual' ? 'zona manual' : 'serial zoom'} ${index + 1} ---\n${item.text}`),
    ]
      .filter(Boolean)
      .join('\n');
    const { labels: _labels, ...identifiers } = recognition;

    return {
      text,
      ...identifiers,
      requestToken: input.requestToken || null,
      image: { width: image.width, height: image.height, orientation: image.orientation },
      passes: summaries,
      calls,
      budget: { maxCalls: budget.maxCalls, callTimeoutMs: budget.callTimeoutMs, totalTimeoutMs: budget.totalTimeoutMs, stoppedReason },
      zoomAttempts: summaries.filter((item) => item.kind === 'zoom').length,
      zoomTextCount: zoomTexts.filter((item) => item.kind === 'zoom').length,
    };
  }

  private async passOrThrow(run: () => Promise<OcrPass | null>, signal?: AbortSignal) {
    const cancelled = () => new HttpException({ message: 'Lectura OCR cancelada.' }, 499 as HttpStatus);
    try {
      await run();
    } catch (error) {
      if (signal?.aborted || error instanceof OcrCancelledError) throw cancelled();
      throw error;
    }
    if (signal?.aborted) throw cancelled();
  }

  /** Hay un serial o un IMEI listos para autocompletar y ninguna etiqueta sin valor legible. */
  private isSatisfied(recognition: RecognitionResult) {
    const ready = recognition.candidates.some((candidate) => candidate.autofill);
    const pending = recognition.labels.some((label) => !label.hasValue) ||
      recognition.candidates.some((candidate) => candidate.labelEvidence !== 'none' && candidate.validation.status !== 'valid');
    return ready && !pending;
  }

  private async resolveImageBuffer(input: VisionOcrDto) {
    const content = this.normalizeBase64(input.imageBase64 || '');
    if (content) return Buffer.from(content, 'base64');
    if (input.imageUrl) return this.downloadImage(input.imageUrl);

    throw new HttpException(
      { message: 'Debes enviar una imagen o una URL de imagen.' },
      HttpStatus.BAD_REQUEST,
    );
  }

  private async downloadImage(rawUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new HttpException({ message: 'URL de imagen invalida.' }, HttpStatus.BAD_REQUEST);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new HttpException({ message: 'Solo se permiten URLs http o https.' }, HttpStatus.BAD_REQUEST);
    }

    this.assertPublicHostname(parsed.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const maxBytes = 12 * 1024 * 1024;

    try {
      const response = await fetch(parsed.toString(), {
        signal: controller.signal,
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        },
      });

      if (!response.ok) {
        throw new HttpException(
          { message: `No se pudo descargar la imagen (${response.status}).` },
          HttpStatus.BAD_REQUEST,
        );
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType && !contentType.toLowerCase().startsWith('image/')) {
        throw new HttpException({ message: 'La URL no parece ser una imagen.' }, HttpStatus.BAD_REQUEST);
      }

      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > maxBytes) {
        throw new HttpException({ message: 'La imagen es demasiado grande.' }, HttpStatus.PAYLOAD_TOO_LARGE);
      }

      const chunks: Buffer[] = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (!reader) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) {
          throw new HttpException({ message: 'La imagen es demasiado grande.' }, HttpStatus.PAYLOAD_TOO_LARGE);
        }
        return buffer;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          throw new HttpException({ message: 'La imagen es demasiado grande.' }, HttpStatus.PAYLOAD_TOO_LARGE);
        }
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { message: 'No se pudo descargar la imagen desde la URL.' },
        HttpStatus.BAD_REQUEST,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertPublicHostname(hostname: string) {
    const host = hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '0.0.0.0' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      throw new HttpException({ message: 'No se permiten URLs privadas o locales.' }, HttpStatus.BAD_REQUEST);
    }
  }

  /** Aplica la orientación EXIF una vez; el mismo búfer se envía a Vision y se recorta, así las cajas coinciden.
   * No reduce la imagen: las etiquetas pequeñas llegan a Vision con su resolución original. */
  async prepareImage(source: Buffer, maxPixels: number): Promise<PreparedImage> {
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(source, { limitInputPixels: maxPixels }).metadata();
    } catch {
      throw new HttpException({ message: 'No se pudo leer la imagen (formato no soportado).' }, HttpStatus.BAD_REQUEST);
    }
    const rawWidth = Number(metadata.width || 0);
    const rawHeight = Number(metadata.height || 0);
    if (!rawWidth || !rawHeight) throw new HttpException({ message: 'No se pudo leer el tamaño de la imagen.' }, HttpStatus.BAD_REQUEST);
    if (rawWidth * rawHeight > maxPixels) {
      throw new HttpException({ message: 'La imagen supera el límite de píxeles del OCR.' }, HttpStatus.PAYLOAD_TOO_LARGE);
    }
    const orientation = Number(metadata.orientation || 1);
    if (orientation === 1) return { buffer: source, width: rawWidth, height: rawHeight, orientation };
    const output = sharp(source, { limitInputPixels: maxPixels }).rotate();
    const buffer = metadata.format === 'png'
      ? await output.png().toBuffer()
      : await output.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
    const swapped = orientation >= 5 && orientation <= 8;
    return { buffer, width: swapped ? rawHeight : rawWidth, height: swapped ? rawWidth : rawHeight, orientation };
  }

  /** Recorta una región (coordenadas de la imagen orientada), la amplía sin reducir nunca y la mejora con moderación.
   * Devuelve la región efectiva (tras recortar a los bordes) para mapear las cajas de vuelta. */
  async cropAndEnhance(image: PreparedImage, region: CropRegion, budget: Pick<OcrBudget, 'zoomMaxWidth' | 'zoomMaxPixels'>) {
    const clamped = this.clampRegion(region, image);
    const byWidth = budget.zoomMaxWidth / clamped.width;
    const byPixels = Math.sqrt(budget.zoomMaxPixels / (clamped.width * clamped.height));
    const scale = Math.max(1, Math.min(4, byWidth, byPixels));
    const buffer = await sharp(image.buffer)
      .extract(clamped)
      .resize({ width: Math.round(clamped.width * scale), kernel: 'lanczos3' })
      .grayscale()
      .normalize()
      .sharpen({ sigma: 1 })
      .jpeg({ quality: 92 })
      .toBuffer();
    return { buffer, region: clamped };
  }

  private async enhance(buffer: Buffer) {
    // JPEG en vez de PNG: una foto en PNG puede superar el tamaño de solicitud que acepta Vision.
    return sharp(buffer).grayscale().normalize().sharpen({ sigma: 1 }).jpeg({ quality: 92 }).toBuffer();
  }

  clampRegion(region: CropRegion, image: { width: number; height: number }): CropRegion {
    const left = Math.max(0, Math.min(image.width - 1, Math.round(region.left)));
    const top = Math.max(0, Math.min(image.height - 1, Math.round(region.top)));
    const right = Math.max(left + 1, Math.min(image.width, Math.round(region.left + region.width)));
    const bottom = Math.max(top + 1, Math.min(image.height, Math.round(region.top + region.height)));
    return { left, top, width: right - left, height: bottom - top };
  }

  regionFromFractions(crop: { x: number; y: number; width: number; height: number }, image: { width: number; height: number }) {
    return this.clampRegion(
      { left: crop.x * image.width, top: crop.y * image.height, width: crop.width * image.width, height: crop.height * image.height },
      image,
    );
  }

  /** Mapea las palabras de una pasada (coordenadas de la imagen enviada) a la imagen orientada original. */
  toPass(id: string, kind: OcrPassKind, data: VisionAnnotateResponse, region: CropRegion, image: { width: number; height: number }): OcrPass {
    const first = data.responses?.[0];
    const text = first?.fullTextAnnotation?.text || first?.textAnnotations?.[0]?.description || '';
    const words: OcrWord[] = [];
    for (const page of first?.fullTextAnnotation?.pages || []) {
      const pageWidth = Number(page.width || 0);
      const pageHeight = Number(page.height || 0);
      if (!pageWidth || !pageHeight) continue;
      const sx = region.width / pageWidth;
      const sy = region.height / pageHeight;
      for (const block of page.blocks || []) {
        for (const paragraph of block.paragraphs || []) {
          for (const word of paragraph.words || []) {
            const value = (word.symbols || []).map((symbol) => symbol.text || '').join('');
            const vertices = word.boundingBox?.vertices || [];
            if (!value || !vertices.length) continue;
            const xs = vertices.map((v) => Number(v.x || 0));
            const ys = vertices.map((v) => Number(v.y || 0));
            const minX = Math.max(0, Math.min(image.width, region.left + Math.min(...xs) * sx));
            const minY = Math.max(0, Math.min(image.height, region.top + Math.min(...ys) * sy));
            const maxX = Math.max(0, Math.min(image.width, region.left + Math.max(...xs) * sx));
            const maxY = Math.max(0, Math.min(image.height, region.top + Math.max(...ys) * sy));
            const x = Math.round(minX);
            const y = Math.round(minY);
            const box: OcrBox = { x, y, width: Math.round(maxX) - x, height: Math.round(maxY) - y };
            words.push({ text: value, box, confidence: typeof word.confidence === 'number' ? word.confidence : null });
          }
        }
      }
    }
    return { id, kind, text, words };
  }

  /** Zonas a releer con zoom: etiquetas sin valor legible o con valor dudoso, sin repetir regiones. */
  retryRegions(recognition: RecognitionResult, image: { width: number; height: number }): CropRegion[] {
    if (this.isSatisfied(recognition)) return [];
    const doubtful = new Set(
      recognition.candidates
        .filter((c) => c.labelEvidence !== 'none' && (c.validation.status !== 'valid' || !c.autofill))
        .map((c) => c.sourcePass),
    );
    const regions = recognition.labels
      .filter((label) => label.box && (!label.hasValue || doubtful.has(label.passId)))
      .map((label) => this.regionAroundLabel(label.box!, image));
    const seen = new Set<string>();
    return regions.filter((region) => {
      const key = [region.left, region.top, region.width, region.height].map((v) => Math.round(v / 40)).join(':');
      if (seen.has(key)) return false;
      seen.add(key);
      return region.width > 20 && region.height > 10;
    });
  }

  /** Franja de la etiqueta: algo a la izquierda, bastante a la derecha y la línea de debajo. */
  regionAroundLabel(label: OcrBox, image: { width: number; height: number }): CropRegion {
    const lineHeight = Math.max(12, label.height);
    const left = label.x - Math.max(16, label.width * 0.5);
    const top = label.y - lineHeight * 1.2;
    return this.clampRegion(
      { left, top, width: Math.max(image.width * 0.5, label.width * 8), height: lineHeight * 4.5 },
      image,
    );
  }

  private async annotateImage(apiKey: string, content: string, timeoutMs: number, signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      // La clave va en cabecera, no en la URL, para que no quede en registros de proxies.
      const response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
        body: JSON.stringify({
          requests: [
            {
              image: { content },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
              imageContext: {
                languageHints: ['en', 'es'],
              },
            },
          ],
        }),
      });

      const data = (await response.json().catch(() => ({}))) as VisionAnnotateResponse;

      if (!response.ok) {
        throw new HttpException(
          {
            message: data?.error?.message || `Cloud Vision rechazo la imagen (${response.status}).`,
          },
          response.status,
        );
      }

      const first = data.responses?.[0];
      if (first?.error?.message) {
        throw new HttpException({ message: first.error.message }, HttpStatus.BAD_GATEWAY);
      }

      return data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (signal?.aborted) throw new OcrCancelledError('cancelled');
      if (controller.signal.aborted) {
        throw new HttpException({ message: 'Cloud Vision no respondió a tiempo.' }, HttpStatus.GATEWAY_TIMEOUT);
      }
      throw new HttpException({ message: 'No se pudo contactar con Cloud Vision.' }, HttpStatus.BAD_GATEWAY);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  private normalizeBase64(value: string) {
    return String(value || '')
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
      .replace(/\s/g, '');
  }
}
