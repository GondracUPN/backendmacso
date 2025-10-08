// src/producto/producto.controller.ts
import {
  Controller,
  Post,
  Get,
  Patch, // ← importa Patch
  Param, // ← importa Param
  Body,
  Delete,
} from '@nestjs/common';
import { ProductoService } from './producto.service';
import { CreateProductoDto } from './dto/create-producto.dto';
import { UpdateProductoDto } from './dto/update-producto.dto';

@Controller('productos')
export class ProductoController {
  constructor(private readonly productoService: ProductoService) {}

  @Post()
  create(@Body() dto: CreateProductoDto) {
    return this.productoService.create(dto);
  }

  @Get()
  findAll() {
    return this.productoService.findAll();
  }

  @Patch(':id') // ← aquí
  update(@Param('id') id: string, @Body() dto: UpdateProductoDto) {
    return this.productoService.update(+id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.productoService.remove(+id);
  }
}
