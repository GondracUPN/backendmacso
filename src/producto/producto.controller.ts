// src/producto/producto.controller.ts
import { Controller, Post, Get, Patch, Param, Body, Delete, HttpException, HttpStatus, Query, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor } from '@nestjs/cache-manager';
import { CacheTTL } from '@nestjs/cache-manager';
import { ProductoService } from './producto.service';
import { CreateProductoDto } from './dto/create-producto.dto';
import { UpdateProductoDto } from './dto/update-producto.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@UseInterceptors(CacheInterceptor)
@Controller('productos')
export class ProductoController {
  constructor(private readonly productoService: ProductoService) {}

  // Crear producto sin autenticaciÃ³n (solicitado para "Servicios" pÃºblico)
  @Post()
  create(@Body() dto: CreateProductoDto) {
    return this.productoService.create(dto);
  }

  // Listado pÃºblico para catÃ¡logo/front
  @Get()
  @CacheTTL(120)
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
  @CacheTTL(60)
  async stats(@Query('refresh') refresh?: string) {
    if (refresh === 'true') return this.productoService.stats();
    return this.productoService.statsCached();
  }

  // Sincroniza al CatÃ¡logo todos los productos disponibles (recogidos y sin venta)
  @Post('catalog-sync')
  async catalogSync() {
    return this.productoService.syncDisponiblesConCatalogo();
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





