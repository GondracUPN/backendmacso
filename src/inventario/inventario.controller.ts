import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Res, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as archiver from 'archiver';
import { UpdateInventarioDto } from './dto/update-inventario.dto';
import { UploadInventarioFotoDto } from './dto/upload-inventario-foto.dto';
import { InventarioService } from './inventario.service';

const PHOTO_DOWNLOAD_CONCURRENCY = 6;
const PHOTO_DOWNLOAD_TIMEOUT_MS = 30000;

type PreparedPhotoFile =
  | { buffer: Buffer; name: string }
  | { error: string };

async function fetchBufferWithTimeout(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOTO_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || '',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function extensionForPhoto(url: string, contentType: string) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('heic')) return 'heic';
  if (type.includes('heif')) return 'heif';
  if (type.includes('gif')) return 'gif';
  const cleanPath = String(url || '').split('?')[0].toLowerCase();
  const match = cleanPath.match(/\.([a-z0-9]{3,5})$/);
  return match?.[1] || 'jpg';
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
    @Body('scope') scope: string,
    @Res() res: Response,
  ) {
    let productoIds: number[] = [];
    try {
      const parsed = JSON.parse(String(rawProductoIds || '[]'));
      productoIds = Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new BadRequestException('Lista de productos invalida.');
    }
    const fichas = scope === 'conFotosPortada'
      ? await this.inventarioService.findAllAvailablePhotoCovers()
      : await this.inventarioService.findPhotoCovers(productoIds);
    const prepared = await mapWithConcurrency(fichas, PHOTO_DOWNLOAD_CONCURRENCY, async (ficha): Promise<PreparedPhotoFile> => {
      try {
        const url = String(ficha.fotoUrl || '').trim();
        if (!url) {
          return { error: `MS-${ficha.productoId}: tiene Fotos marcado pero no tiene portada guardada.` };
        }
        const photo = await fetchBufferWithTimeout(url);
        if (!photo) {
          return { error: `MS-${ficha.productoId}: no se pudo descargar la portada.` };
        }
        return {
          buffer: photo.buffer,
          name: `MS-${ficha.productoId}-portada.${extensionForPhoto(url, photo.contentType)}`,
        };
      } catch {
        return { error: `MS-${ficha.productoId}: no se pudo descargar la portada.` };
      }
    });
    const files = prepared.filter((file): file is { buffer: Buffer; name: string } => 'buffer' in file);
    const errors = prepared.filter((file): file is { error: string } => 'error' in file);
    if (errors.length) {
      throw new BadRequestException(`No se generó el ZIP porque hay portadas que no se pudieron descargar:\n${errors.map((item) => item.error).join('\n')}`);
    }
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
