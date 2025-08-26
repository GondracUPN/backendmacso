import { Controller, Post, Body, Get, Param, ParseIntPipe, Patch, Delete } from '@nestjs/common';
import { VentaService } from './venta.service';
import { CreateVentaDto } from './dto/create-venta.dto';
import { UpdateVentaDto } from './dto/update-venta.dto';

@Controller('ventas')
export class VentaController {
  constructor(private readonly svc: VentaService) {}

  @Post()
  create(@Body() dto: CreateVentaDto) {
    return this.svc.create(dto);
  }

  @Get('producto/:pid')
  byProducto(@Param('pid', ParseIntPipe) pid: number) {
    return this.svc.findByProducto(pid);
  }

  @Get(':id')
  one(@Param('id', ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateVentaDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(id);
  }
}
