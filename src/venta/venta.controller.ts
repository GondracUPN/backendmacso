import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
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
  BadRequestException,
} from '@nestjs/common';
import { VentaService } from './venta.service';
import { CreateVentaDto } from './dto/create-venta.dto';
import { UpdateVentaDto } from './dto/update-venta.dto';
import { CreateVentaAdelantoDto } from './dto/create-venta-adelanto.dto';
import { CompleteVentaAdelantoDto } from './dto/complete-venta-adelanto.dto';
import { AddVentaAdelantoCuotaDto } from './dto/add-venta-adelanto-cuota.dto';
import { CancelVentaAdelantoDto } from './dto/cancel-venta-adelanto.dto';
import { DevolverVentaDto, EliminarVentaDto } from './dto/devolver-venta.dto';
import { CurrentUser, JwtUserPayload } from '../auth/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ventas')
export class VentaController {
  constructor(private readonly svc: VentaService) {}

  private parseIds(value: unknown): number[] {
    const values = Array.isArray(value) ? value : String(value || '').split(',');
    const ids = [...new Set(values.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (ids.length > 2000) throw new BadRequestException('Maximo 2000 ids por lote');
    return ids;
  }

  @Get('adelantos/resumen')
  resumenAdelantos(@Query('ids') ids?: string) {
    return this.svc.resumenAdelantos(this.parseIds(ids));
  }

  @Post('adelantos/resumen')
  resumenAdelantosBatch(@Body('ids') ids: number[]) {
    return this.svc.resumenAdelantos(this.parseIds(ids));
  }

  @Post('ultimas')
  latestByProductoBatch(@Body('ids') ids: number[]) {
    const parsed = this.parseIds(ids);
    return this.svc.findLatestByProductos(parsed.length ? parsed : undefined);
  }

  @Post('adelantos/ultimos')
  latestAdelantosBatch(@Body('ids') ids: number[]) {
    const parsed = this.parseIds(ids);
    return this.svc.findLatestAdelantosByProductos(parsed.length ? parsed : undefined);
  }

  // GET /ventas?from=YYYY-MM-DD&to=YYYY-MM-DD&unassigned=true&productoId=123&vendedor=gonzalo
  @Get()
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('unassigned') unassigned?: string,
    @Query('productoId') productoId?: string,
    @Query('vendedor') vendedor?: string,
  ) {
    return this.svc.findAll({
      from,
      to,
      unassigned: unassigned === 'true',
      productoId: productoId ? Number(productoId) : undefined,
      vendedor,
    });
  }

  @Roles('admin')
  @Post()
  async create(@Body() dto: CreateVentaDto) {
    return this.svc.resultadoVenta(await this.svc.create(dto));
  }

  @Roles('admin')
  @Post('adelanto')
  createAdelanto(@Body() dto: CreateVentaAdelantoDto) {
    return this.svc.createAdelanto(dto);
  }

  @Roles('admin')
  @Post('adelanto/:id/cuotas')
  addAdelantoCuota(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddVentaAdelantoCuotaDto,
  ) {
    return this.svc.addAdelantoCuota(id, dto);
  }

  @Get('adelanto/:id')
  findAdelanto(@Param('id', ParseIntPipe) id: number) {
    return this.svc.resumenAdelanto(id);
  }

  @Roles('admin')
  @Patch('adelanto/:id/cuotas/:index')
  updateAdelantoCuota(
    @Param('id', ParseIntPipe) id: number,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: AddVentaAdelantoCuotaDto,
  ) {
    return this.svc.updateAdelantoCuota(id, index, dto);
  }

  @Roles('admin')
  @Delete('adelanto/:id/cuotas/:index')
  deleteAdelantoCuota(
    @Param('id', ParseIntPipe) id: number,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.svc.deleteAdelantoCuota(id, index);
  }

  @Roles('admin')
  @Post('adelanto/:id/completar')
  completeAdelanto(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CompleteVentaAdelantoDto,
  ) {
    return this.svc.completeAdelanto(id, dto);
  }

  // Cancela la reserva conservando su historial; por defecto devuelve todo lo adelantado hoy.
  @Roles('admin')
  @Delete('adelanto/:id')
  cancelAdelanto(@Param('id', ParseIntPipe) id: number, @Body() dto?: CancelVentaAdelantoDto) {
    return this.svc.cancelAdelanto(id, dto || {});
  }

  @Get('producto/:pid')
  byProducto(@Param('pid', ParseIntPipe) pid: number) {
    return this.svc.findByProducto(pid);
  }

  @Get('ultimas')
  latestByProducto(@Query('ids') ids?: string) {
    const parsedIds =
      ids
        ?.split(',')
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0) || [];

    return this.svc.findLatestByProductos(parsedIds.length ? parsedIds : undefined);
  }

  @Get('similares')
  similarSold(
    @Query('productoId') productoId?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedProductId = Number(productoId);
    if (!Number.isFinite(parsedProductId) || parsedProductId <= 0) {
      throw new BadRequestException('productoId invalido');
    }
    return this.svc.findSimilarSold(parsedProductId, Number(limit) || 8);
  }

  @Get('accesorio-resumen')
  accessorySummary(@Query('productoId') productoId?: string) {
    const parsedProductId = Number(productoId);
    if (!Number.isInteger(parsedProductId) || parsedProductId <= 0) {
      throw new BadRequestException('productoId invalido');
    }
    return this.svc.getAccessorySalesSummary(parsedProductId);
  }

  @Get('adelantos/ultimos')
  latestAdelantosByProducto(@Query('ids') ids?: string) {
    const parsedIds =
      ids
        ?.split(',')
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0) || [];

    return this.svc.findLatestAdelantosByProductos(parsedIds.length ? parsedIds : undefined);
  }

  @Get('a-pedido')
  pedidoSummary() {
    return this.svc.pedidoSummary();
  }

  @Get(':id')
  one(@Param('id', ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }

  @Get(':id/cobros')
  salePayments(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getSalePayments(id);
  }

  @Get(':id/devoluciones')
  devoluciones(@Param('id', ParseIntPipe) id: number) {
    return this.svc.listarDevoluciones(id);
  }

  @Roles('admin')
  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateVentaDto) {
    return this.svc.resultadoVenta(await this.svc.update(id, dto));
  }

  @Roles('admin')
  @Post(':id/devoluciones')
  devolver(@Param('id', ParseIntPipe) id: number, @Body() dto: DevolverVentaDto, @CurrentUser() user: JwtUserPayload) {
    return this.svc.devolver(id, dto, user.userId);
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Body() dto: EliminarVentaDto) {
    return this.svc.remove(id, dto.motivo);
  }
}
