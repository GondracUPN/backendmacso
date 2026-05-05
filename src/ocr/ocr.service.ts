import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { VisionOcrDto } from './dto/vision-ocr.dto';

type Vertex = { x?: number; y?: number };
type BoundingPoly = { vertices?: Vertex[] };
type VisionWord = { symbols?: Array<{ text?: string }>; boundingBox?: BoundingPoly };
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

type WordBox = {
  text: string;
  normalized: string;
  pageWidth: number;
  pageHeight: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type CropRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

@Injectable()
export class OcrService {
  constructor(private readonly config: ConfigService) {}

  async detectText(input: VisionOcrDto) {
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

    const sourceBuffer = await this.resolveImageBuffer(input);
    const content = sourceBuffer.toString('base64');

    const firstPass = await this.annotateImage(apiKey, content);
    const originalText = this.extractText(firstPass);
    const cropRegions = this.findSerialCropRegions(firstPass).slice(0, 4);
    const cropTexts: string[] = [];

    for (const region of cropRegions) {
      try {
        const cropped = await this.cropAndZoom(sourceBuffer, region);
        const cropPass = await this.annotateImage(apiKey, cropped.toString('base64'));
        const cropText = this.extractText(cropPass);
        if (cropText.trim()) cropTexts.push(cropText);
      } catch (error) {
        console.log('[OCR][serial_crop] error', (error as any)?.message || error);
      }
    }

    const text = [originalText, ...cropTexts.map((item, index) => `--- serial zoom ${index + 1} ---\n${item}`)]
      .filter(Boolean)
      .join('\n');

    return {
      text,
      zoomAttempts: cropRegions.length,
      zoomTextCount: cropTexts.length,
    };
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

  private async annotateImage(apiKey: string, content: string) {
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      },
    );

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
  }

  private extractText(data: VisionAnnotateResponse) {
    const first = data.responses?.[0];
    return first?.fullTextAnnotation?.text || first?.textAnnotations?.[0]?.description || '';
  }

  private findSerialCropRegions(data: VisionAnnotateResponse) {
    const pages = data.responses?.[0]?.fullTextAnnotation?.pages || [];
    const regions: CropRegion[] = [];

    for (const page of pages) {
      const words = this.extractWordBoxes(page);
      for (let i = 0; i < words.length; i += 1) {
        const word = words[i];
        const next = words[i + 1];
        const isSerial =
          word.normalized === 'SN' ||
          word.normalized === 'S/N' ||
          word.normalized === 'SERIE' ||
          word.normalized === 'SERIAL' ||
          (word.normalized === 'S' && next?.normalized === 'N');

        if (!isSerial) continue;

        const labelBox = this.mergeBoxes([word, next && word.normalized === 'SERIAL' ? next : undefined]);
        if (!labelBox) continue;

        regions.push(...this.regionsAroundLabel(labelBox));
      }
    }

    return this.uniqueRegions(regions);
  }

  private extractWordBoxes(page: VisionPage): WordBox[] {
    const pageWidth = Number(page.width || 0);
    const pageHeight = Number(page.height || 0);
    const words: WordBox[] = [];

    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const text = (word.symbols || []).map((symbol) => symbol.text || '').join('');
          const vertices = word.boundingBox?.vertices || [];
          const xs = vertices.map((v) => Number(v.x || 0));
          const ys = vertices.map((v) => Number(v.y || 0));
          if (!text || xs.length === 0 || ys.length === 0 || !pageWidth || !pageHeight) continue;
          words.push({
            text,
            normalized: this.normalizeWord(text),
            pageWidth,
            pageHeight,
            minX: Math.min(...xs),
            minY: Math.min(...ys),
            maxX: Math.max(...xs),
            maxY: Math.max(...ys),
          });
        }
      }
    }

    return words;
  }

  private mergeBoxes(items: Array<WordBox | undefined>): WordBox | undefined {
    const boxes = items.filter(Boolean) as WordBox[];
    if (!boxes.length) return undefined;
    return {
      ...boxes[0],
      minX: Math.min(...boxes.map((box) => box.minX)),
      minY: Math.min(...boxes.map((box) => box.minY)),
      maxX: Math.max(...boxes.map((box) => box.maxX)),
      maxY: Math.max(...boxes.map((box) => box.maxY)),
    };
  }

  private regionsAroundLabel(label: WordBox): CropRegion[] {
    const labelHeight = Math.max(18, label.maxY - label.minY);
    const padX = Math.max(24, label.pageWidth * 0.025);
    const padY = Math.max(18, labelHeight * 1.4);
    const rightStart = Math.max(0, label.minX - padX);
    const lineTop = Math.max(0, label.minY - padY);
    const lineHeight = Math.min(label.pageHeight - lineTop, Math.max(labelHeight * 5, label.pageHeight * 0.12));
    const belowTop = Math.max(0, label.minY - padY);
    const belowHeight = Math.min(label.pageHeight - belowTop, Math.max(labelHeight * 8, label.pageHeight * 0.18));

    return [
      {
        left: rightStart,
        top: lineTop,
        width: Math.min(label.pageWidth - rightStart, Math.max(label.pageWidth * 0.45, label.maxX - rightStart + label.pageWidth * 0.35)),
        height: lineHeight,
      },
      {
        left: Math.max(0, label.minX - label.pageWidth * 0.18),
        top: belowTop,
        width: Math.min(label.pageWidth, label.pageWidth * 0.72),
        height: belowHeight,
      },
      {
        left: 0,
        top: Math.max(0, label.minY - padY),
        width: label.pageWidth,
        height: Math.min(label.pageHeight, Math.max(labelHeight * 6, label.pageHeight * 0.14)),
      },
    ];
  }

  private uniqueRegions(regions: CropRegion[]) {
    const seen = new Set<string>();
    return regions.filter((region) => {
      const key = [
        Math.round(region.left / 20),
        Math.round(region.top / 20),
        Math.round(region.width / 20),
        Math.round(region.height / 20),
      ].join(':');
      if (seen.has(key)) return false;
      seen.add(key);
      return region.width > 40 && region.height > 20;
    });
  }

  private async cropAndZoom(source: Buffer, region: CropRegion) {
    const metadata = await sharp(source).metadata();
    const imageWidth = Number(metadata.width || 0);
    const imageHeight = Number(metadata.height || 0);
    if (!imageWidth || !imageHeight) throw new Error('No se pudo leer el tamano de la imagen.');

    const left = Math.max(0, Math.min(imageWidth - 1, Math.round(region.left)));
    const top = Math.max(0, Math.min(imageHeight - 1, Math.round(region.top)));
    const width = Math.max(1, Math.min(imageWidth - left, Math.round(region.width)));
    const height = Math.max(1, Math.min(imageHeight - top, Math.round(region.height)));

    return sharp(source)
      .extract({ left, top, width, height })
      .resize({ width: Math.min(3200, width * 4), withoutEnlargement: false })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
  }

  private normalizeWord(value: string) {
    return String(value || '')
      .toUpperCase()
      .replace(/[|]/g, 'I')
      .replace(/[^A-Z0-9/]/g, '');
  }

  private normalizeBase64(value: string) {
    return String(value || '')
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
      .replace(/\s/g, '');
  }
}
