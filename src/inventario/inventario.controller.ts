import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { UpdateInventarioDto } from './dto/update-inventario.dto';
import { UploadInventarioFotoDto } from './dto/upload-inventario-foto.dto';
import { InventarioService } from './inventario.service';

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

  @Delete(':productoId/foto')
  deleteFoto(@Param('productoId', ParseIntPipe) productoId: number) {
    return this.inventarioService.deleteFoto(productoId);
  }
}
