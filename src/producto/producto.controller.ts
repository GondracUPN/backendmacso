// src/producto/producto.controller.ts
import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { ProductoService } from './producto.service';
import { CreateProductoDto } from './dto/create-producto.dto';
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

  // Listado público para catálogo/front
  @Get()
  findAll() {
    return this.productoService.findAll();
  }

  // Sincroniza al Catálogo todos los productos disponibles (recogidos y sin venta)
  @Post('catalog-sync')
  async catalogSync() {
    return this.productoService.syncDisponiblesConCatalogo();
  }

  // Solo admin edita
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Param('id') id: string, @Body() dto: UpdateProductoDto) {
    return this.productoService.update(+id, dto);
  }

  // Solo admin borra
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  remove(@Param('id') id: string) {
    return this.productoService.remove(+id);
  }
}
