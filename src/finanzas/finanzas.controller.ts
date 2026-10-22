import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUserPayload,
} from '../auth/decorators/current-user.decorator';
import { FinanzasService } from './finanzas.service';
import { FinanzasAnalisisService } from './finanzas-analisis.service';
import { FinanzasLedgerService } from './finanzas-ledger.service';
import {
  ActualizarCuentaDto,
  CompletarCostoDto,
  AnularDto,
  CerrarProductoDto,
  ClasificarGastoDto,
  ConciliarLoteDto,
  ConciliarVentaDto,
  CrearReembolsoDto,
  CuentaDto,
  EventoReembolsoDto,
  MovimientoDto,
  PrecioPactadoDto,
  RegistrarEventoPagoDto,
  RegistrarPagoDto,
  VentaRapidaDto,
} from './dto/finanzas.dto';

const int = (value?: string) =>
  value && Number.isInteger(Number(value)) ? Number(value) : undefined;
const thisMonth = () => {
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Lima',
  });
  const [y, m] = today.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${today.slice(0, 7)}-01`,
    to: `${today.slice(0, 7)}-${String(last).padStart(2, '0')}`,
  };
};

/** Datos financieros: solo usuarios autenticados con rol administrador. */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('finanzas')
export class FinanzasController {
  constructor(
    private readonly svc: FinanzasService,
    private readonly analisis: FinanzasAnalisisService,
    private readonly ledger: FinanzasLedgerService,
  ) {}

  // — Análisis —
  @Get('analisis')
  getAnalisis(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('tipo') tipo?: string,
    @Query('vendedor') vendedor?: string,
    @Query('cuentaId') cuentaId?: string,
    @Query('metodo') metodo?: string,
    @Query('estadoCobro') estadoCobro?: string,
    @Query('productoId') productoId?: string,
    @Query('incluirNoVerificados') incluirNoVerificados?: string,
  ) {
    const def = thisMonth();
    return this.analisis.analisis({
      from: from || def.from,
      to: to || def.to,
      tipo: tipo || undefined,
      vendedor: vendedor || undefined,
      cuentaId: int(cuentaId),
      metodo: metodo || undefined,
      estadoCobro: estadoCobro || undefined,
      productoId: int(productoId),
      incluirNoVerificados: incluirNoVerificados === 'true',
    });
  }

  @Get('ventas')
  listarVentas(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('tipo') tipo?: string,
    @Query('estadoCobro') estadoCobro?: string,
    @Query('conciliacion') conciliacion?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.analisis.listarVentas({
      from,
      to,
      tipo,
      estadoCobro,
      conciliacion,
      page: int(page),
      pageSize: int(pageSize),
    });
  }

  @Get('ventas/:id')
  detalleVenta(@Param('id', ParseIntPipe) id: number) {
    return this.svc.detalleVenta(id);
  }

  @Get('costos-pendientes')
  costosPendientes() { return this.svc.costosPendientes(); }

  @Patch('ventas/:id/costo')
  completarCosto(@Param('id', ParseIntPipe) id: number, @Body() dto: CompletarCostoDto, @CurrentUser() user: JwtUserPayload) {
    return this.svc.completarCosto(id, dto.costoTotal, dto.documento, user.userId);
  }

  @Patch('ventas/:id/precio-pactado')
  precioPactado(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PrecioPactadoDto,
  ) {
    return this.svc.precioPactado(id, dto.precioLista);
  }

  // — Pagos y liquidaciones —
  @Post('pagos')
  registrarPago(@Body() dto: RegistrarPagoDto) {
    return this.ledger.registrarPago(dto);
  }

  @Post('pagos/:id/eventos')
  registrarEvento(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RegistrarEventoPagoDto,
  ) {
    return this.ledger.registrarEvento(id, dto);
  }

  @Post('pagos/:id/anular')
  anularPago(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularDto) {
    return this.ledger.anularPago(id, dto.motivo);
  }

  // — Cuentas y movimientos —
  @Get('cuentas')
  cuentas() {
    return this.svc.listarCuentas();
  }

  @Post('cuentas')
  crearCuenta(@Body() dto: CuentaDto) {
    return this.svc.crearCuenta(dto);
  }

  @Patch('cuentas/:id')
  actualizarCuenta(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ActualizarCuentaDto,
  ) {
    return this.svc.actualizarCuenta(id, dto);
  }

  @Get('movimientos')
  movimientos(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
  ) {
    return this.svc.listarMovimientos({ from, to, page: int(page) });
  }

  @Post('movimientos')
  registrarMovimiento(
    @Body() dto: MovimientoDto,
    @CurrentUser() user: JwtUserPayload,
  ) {
    return this.svc.registrarMovimiento(dto, user?.userId);
  }

  @Post('movimientos/:id/anular')
  anularMovimiento(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AnularDto,
  ) {
    return this.svc.anularMovimiento(id, dto.motivo);
  }

  // — Conciliación histórica —
  @Get('conciliacion')
  conciliacionPendiente(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.listarConciliacionPendiente({
      page: int(page),
      pageSize: int(pageSize),
    });
  }

  @Post('conciliacion/importar')
  importarHistorico(@Query('aplicar') aplicar?: string) {
    return this.svc.backfillHistorico(aplicar !== 'true');
  }

  @Post('conciliacion/lote')
  conciliarLote(
    @Body() dto: ConciliarLoteDto,
    @CurrentUser() user: JwtUserPayload,
  ) {
    return this.svc.conciliarLote(dto.ventaIds, user?.userId);
  }

  @Post('conciliacion/:ventaId')
  conciliarVenta(
    @Param('ventaId', ParseIntPipe) ventaId: number,
    @Body() dto: ConciliarVentaDto,
    @CurrentUser() user: JwtUserPayload,
  ) {
    return this.svc.conciliarVenta(ventaId, dto, user?.userId);
  }

  // — Gastos —
  @Get('gastos/sin-clasificar')
  gastosSinClasificar(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
  ) {
    return this.svc.listarGastosSinClasificar({ from, to, page: int(page) });
  }

  @Patch('gastos/:id/clasificacion')
  clasificarGasto(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ClasificarGastoDto,
  ) {
    return this.svc.clasificarGasto(id, dto);
  }

  // — Reembolsos y productos —
  @Get('reembolsos')
  reembolsos(
    @Query('productoId') productoId?: string,
    @Query('abiertos') abiertos?: string,
  ) {
    return this.svc.listarReembolsos({
      productoId: int(productoId),
      abiertos: abiertos === 'true',
    });
  }

  @Post('reembolsos')
  crearReembolso(@Body() dto: CrearReembolsoDto) {
    return this.svc.crearReembolso(dto);
  }

  @Post('reembolsos/:id/eventos')
  eventoReembolso(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: EventoReembolsoDto,
    @CurrentUser() user: JwtUserPayload,
  ) {
    return this.svc.eventoReembolso(id, dto, user.userId);
  }

  @Patch('productos/:id/cierre')
  cerrarProducto(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CerrarProductoDto,
  ) {
    return this.svc.cerrarProducto(id, dto.motivo);
  }

  // — Venta rápida —
  @Get('accesorios')
  accesorios() {
    return this.svc.accesoriosDisponibles();
  }

  @Post('ventas-rapidas')
  ventaRapida(@Body() dto: VentaRapidaDto) {
    return this.svc.ventaRapida(dto);
  }
}
