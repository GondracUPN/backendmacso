// src/producto/producto.controller.ts
import { Controller, Post, Get, Patch, Param, Body, Delete, HttpException, HttpStatus, Query } from "@nestjs/common";
import { ProductoService } from './producto.service';
import { CreateProductoDto } from './dto/create-producto.dto';
import { CreateProductoLoteDto } from './dto/create-producto-lote.dto';
import { UpdateProductoDto } from './dto/update-producto.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('productos')
export class ProductoController {
  constructor(private readonly productoService: ProductoService) {}

  // Crear producto sin autenticación (solicitado para "Servicios" público)
  @Post()
  create(@Body() dto: CreateProductoDto) {
    return this.productoService.create(dto);
  }

  @Post('lote')
  createLote(@Body() dto: CreateProductoLoteDto) {
    return this.productoService.createLote(dto);
  }

  // Listado público para catálogo/front
  @Get()
    async findAll() {
    try {
      const res = await this.productoService.findAll();
      return res;
    } catch (e: any) {
      // Exponer detalle en logs y retornar mensaje útil al cliente
      // Posible causa: columnas con acentos en DB (e.g., "tamaño")
      console.error('[GET /productos] error:', e);
      throw new HttpException(
        { message: 'Error al listar productos', error: String(e?.message || e) },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // KPIs rápidos para gestión (disponibles, vendidos, total ventas, ganancia total)
  @Get('stats')
    async stats(@Query('refresh') refresh?: string) {
    if (refresh === 'true') return this.productoService.stats();
    return this.productoService.statsCached();
  }

  // Resumen completo para gestiÇün de productos
  @Get('resumen')
    async resumen(@Query('refresh') refresh?: string) {
    return this.productoService.resumenCached(refresh === 'true');
  }

  // Sincroniza al Catálogo todos los productos disponibles (recogidos y sin venta)
  @Post('catalog-sync')
  async catalogSync() {
    return this.productoService.syncDisponiblesConCatalogo();
  }

  @Get('catalog-pending')
  catalogPending() {
    return this.productoService.findPendientesCatalogo();
  }

  @Post('recalcular-envios-nueva-tarifa')
  async recalcularEnviosNuevaTarifa(@Body() body?: { cutoffDate?: string }) {
    return this.productoService.recalcularEnviosNuevaTarifa(body?.cutoffDate);
  }

  @Get('personal-eshopex')
  personalEshopex() {
    return this.productoService.findPersonalEshopex();
  }

  @Post('personal-eshopex')
  guardarPersonalEshopex(@Body() body: any) {
    return this.productoService.upsertPersonalEshopex(body);
  }

  @Patch('personal-eshopex/:id')
  actualizarPersonalEshopex(@Param('id') id: string, @Body() body: any) {
    return this.productoService.updatePersonalEshopex(+id, body);
  }

  @Delete('personal-eshopex/:id')
  borrarPersonalEshopex(@Param('id') id: string) {
    return this.productoService.removePersonalEshopex(+id);
  }

  @Patch(':id/despacho-casillero')
  marcarDespachoCasillero(@Param('id') id: string) {
    return this.productoService.marcarDespachoCasillero(+id);
  }

  @Patch(':id/despacho-casillero/anular')
  anularDespachoCasillero(@Param('id') id: string) {
    return this.productoService.anularDespachoCasillero(+id);
  }

  // Editar producto (sin auth para flujo Servicios)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductoDto) {
    return this.productoService.update(+id, dto);
  }

  // Solo admin borra
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.productoService.remove(+id);
  }
}
