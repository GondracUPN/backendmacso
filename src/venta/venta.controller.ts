import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Delete,
  Query,
} from '@nestjs/common';
import { VentaService } from './venta.service';
import { CreateVentaDto } from './dto/create-venta.dto';
import { UpdateVentaDto } from './dto/update-venta.dto';

@Controller('ventas')
export class VentaController {
  constructor(private readonly svc: VentaService) {}

  // GET /ventas?from=YYYY-MM-DD&to=YYYY-MM-DD&unassigned=true&productoId=123
  @Get()
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('unassigned') unassigned?: string,
    @Query('productoId') productoId?: string,
  ) {
    return this.svc.findAll({
      from,
      to,
      unassigned: unassigned === 'true',
      productoId: productoId ? Number(productoId) : undefined,
    });
  }

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
