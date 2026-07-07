import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as archiver from 'archiver';
import sharp = require('sharp');
import { UpdateInventarioDto } from './dto/update-inventario.dto';
import { UploadInventarioFotoDto } from './dto/upload-inventario-foto.dto';
import { InventarioService } from './inventario.service';

const PHOTO_DOWNLOAD_CONCURRENCY = 6;
const PHOTO_DOWNLOAD_TIMEOUT_MS = 30000;

export async function watermarkInventoryPhoto(photo: Buffer, watermark: Buffer) {
  const base = sharp(photo).rotate();
  const metadata = await base.metadata();
  const width = Math.max(1, Number(metadata.width) || 1);
  const watermarkWidth = Math.max(1, Math.round(width * 0.7));
  const overlay = await sharp(watermark)
    .resize({ width: watermarkWidth, withoutEnlargement: false })
    .ensureAlpha()
    .linear([1, 1, 1, 0.2], [0, 0, 0, 0])
    .png()
    .toBuffer();
  return base
    .composite([{ input: overlay, gravity: 'centre' }])
    .jpeg({ quality: 98, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

async function fetchBufferWithTimeout(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOTO_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

@Controller('inventario')
export class InventarioController {
  constructor(private readonly inventarioService: InventarioService) {}

  @Get()
  findDisponibles() {
    return this.inventarioService.findDisponibles();
  }

  @Get('producto/:productoId')
  findProductoByCode(@Param('productoId', ParseIntPipe) productoId: number) {
    return this.inventarioService.findProductoByCode(productoId);
  }

  @Patch(':productoId')
  upsert(
    @Param('productoId', ParseIntPipe) productoId: number,
    @Body() dto: UpdateInventarioDto,
  ) {
    return this.inventarioService.upsert(productoId, dto);
  }

  @Post(':productoId/foto')
  uploadFoto(
    @Param('productoId', ParseIntPipe) productoId: number,
    @Body() dto: UploadInventarioFotoDto,
  ) {
    return this.inventarioService.uploadFoto(productoId, dto.dataUrl);
  }

  @Post('fotos-zip')
  @UseInterceptors(FileInterceptor('watermark', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async downloadPhotoCovers(
    @Body('productoIds') rawProductoIds: string,
    @UploadedFile() watermarkFile: any,
    @Res() res: Response,
  ) {
    if (!watermarkFile?.buffer) throw new BadRequestException('Marca de agua requerida.');
    let productoIds: number[] = [];
    try {
      const parsed = JSON.parse(String(rawProductoIds || '[]'));
      productoIds = Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new BadRequestException('Lista de productos invalida.');
    }
    const fichas = await this.inventarioService.findPhotoCovers(productoIds);
    const files = (await mapWithConcurrency(fichas, PHOTO_DOWNLOAD_CONCURRENCY, async (ficha) => {
      try {
        const photo = await fetchBufferWithTimeout(String(ficha.fotoUrl));
        if (!photo) return null;
        return {
          buffer: await watermarkInventoryPhoto(photo, watermarkFile.buffer),
          name: `MS-${ficha.productoId}-portada.jpg`,
        };
      } catch {
        // Si una portada falla, se continua con las demas.
        return null;
      }
    })).filter((file): file is { buffer: Buffer; name: string } => Boolean(file));
    if (!files.length) throw new BadRequestException('No se pudieron descargar las portadas.');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="inventario-portadas.zip"');
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', (error) => res.destroy(error));
    archive.pipe(res);
    files.forEach((file) => archive.append(file.buffer, { name: file.name }));
    await archive.finalize();
  }

  @Delete(':productoId/foto')
  deleteFoto(@Param('productoId', ParseIntPipe) productoId: number) {
    return this.inventarioService.deleteFoto(productoId);
  }
}
