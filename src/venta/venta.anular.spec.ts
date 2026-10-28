import { BadRequestException } from '@nestjs/common';
import { VentaService } from './venta.service';
import { Venta } from './venta.entity';
import { VentaAdelanto } from './venta-adelanto.entity';
import { VentaDevolucion } from './venta-devolucion.entity';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { User } from '../auth/entities/user.entity';
import { VentaPago } from '../finanzas/entities/venta-pago.entity';
import { PagoLiquidacion } from '../finanzas/entities/pago-liquidacion.entity';
import { CuentaFinanciera } from '../finanzas/entities/cuenta-financiera.entity';
import { FinanzasLedgerService, toPagoCalc } from '../finanzas/finanzas-ledger.service';
import { finanzasVenta } from '../finanzas/finanzas-calc';
import { createStore } from './memory-store.test-helper';

function createService(store: ReturnType<typeof createStore>, ledger?: FinanzasLedgerService) {
  const m = store.manager;
  const cache = { del: jest.fn(async () => undefined) };
  const service = new VentaService(m.getRepository(Venta), { ...m.getRepository(VentaAdelanto), manager: m } as any,
    m.getRepository(Producto), m.getRepository(ProductoValor), cache as any, m.getRepository(Gasto), m.getRepository(User),
    ledger ?? new FinanzasLedgerService({ manager: m, transaction: m.transaction } as any));
  return { service, cache };
}

const venta = (over: any = {}) => ({ id: 1, productoId: 10, cantidad: 1, precioVenta: '3000.00', ganancia: '600.00', fechaVenta: '2026-05-10',
  estadoComercial: 'entregada', vendedor: 'Gonzalo', costoDevuelto: 0, precioDevuelto: 0, cantidadDevuelta: 0, conciliacionHistorica: 'no_aplica', ...over });
const ingreso = (id: number, over: any = {}) => ({ id, concepto: 'ingreso', metodoPago: 'debito', saleId: 1, userId: 1, monto: '3000.00', notas: '__SALE_INCOME__:10:1', fecha: '2026-05-10', ...over });
const pago = (id: number, over: any = {}) => ({ id, ventaId: 1, adelantoId: null, monto: '3000.00', montoPen: '3000.00', fechaPago: '2026-05-10',
  estado: 'disponible', requiereLiquidacion: false, comisionEstimada: '0', origen: 'ingreso_venta', verificado: true, anuladoAt: null, idempotencyKey: `k${id}`, ...over });

describe('VentaService.anular', () => {
  it('anula una venta normal cobrada: retira sus ingresos, anula sus pagos y conserva costos ajenos', async () => {
    const store = createStore({
      Venta: [venta()], Producto: [{ id: 10, tipo: 'macbook', stockActual: 1, stockInicial: 1 }],
      Gasto: [ingreso(1), ingreso(2, { concepto: 'envio', notas: 'envio de la venta' }), ingreso(3, { saleId: null, notas: 'otro ingreso' })],
      VentaPago: [pago(1, { gastoId: 1 })],
    });
    const { service, cache } = createService(store);

    const result = await service.anular(1, 7, 'Venta registrada por error');

    expect(result).toMatchObject({ estadoComercial: 'cancelada', anuladaPor: 7, anulacionMotivo: 'Venta registrada por error' });
    expect(result.anuladaAt).toBeInstanceOf(Date);
    expect(store.rows(Gasto).map((g) => g.id)).toEqual([2, 3]);
    expect(store.rows(VentaPago)[0]).toMatchObject({ estado: 'anulado', anuladoAt: expect.any(Date) });
    expect(store.rows(Gasto).some((g) => g.concepto === 'devolucion_venta')).toBe(false);
    expect(store.rows(Producto)[0].stockActual).toBe(1);
    expect(cache.del).toHaveBeenCalledWith('productos:stats');
    const calc = finanzasVenta({ id: 1, fechaComercial: '2026-05-10', precioCents: 300000, gananciaCents: 60000, estadoComercial: 'cancelada' },
      store.rows(VentaPago).map((p) => toPagoCalc(p)));
    expect(calc).toMatchObject({ cobradoClienteCents: 0, saldoPendienteCents: 0, disponibleCents: 0, gananciaFinalCents: 0 });
  });

  it('retira todas las partes por vendedor y tipo de pago, incluidos cobros liquidados', async () => {
    const store = createStore({
      Venta: [venta({ vendedor: 'Ambos' })], Producto: [{ id: 10, tipo: 'macbook' }],
      Gasto: [
        ingreso(1, { userId: 1, monto: '1000.00', notas: '__SALE_INCOME__:10:1:direct', salePaymentType: 'direct' }),
        ingreso(2, { userId: 2, monto: '1000.00', notas: '__SALE_INCOME__:10:1:direct', salePaymentType: 'direct' }),
        ingreso(3, { userId: 1, monto: '500.00', notas: '__SALE_INCOME__:10:1:card', salePaymentType: 'card' }),
        ingreso(4, { userId: 2, monto: '500.00', notas: '__SALE_INCOME__:10:1:card', salePaymentType: 'card' }),
      ],
      VentaPago: [pago(1, { montoPen: '2000.00' }), pago(2, { montoPen: '1000.00', origen: 'manual', requiereLiquidacion: true })],
      PagoLiquidacion: [{ id: 1, pagoId: 2, tipo: 'liquidacion', fecha: '2026-05-20', montoBruto: '1000.00', comision: '30.00', montoNeto: '970.00', cuentaId: 3 }],
    });
    const { service } = createService(store);

    await service.anular(1, 7);

    expect(store.rows(Gasto)).toHaveLength(0);
    expect(store.rows(VentaPago).every((p) => p.estado === 'anulado' && p.anuladoAt)).toBe(true);
    // El evento se conserva como historial; las lecturas lo excluyen por su pago anulado.
    expect(store.rows(PagoLiquidacion)).toHaveLength(1);
  });

  it('cancela la reserva completada, retira sus ingresos de adelanto y no la vuelve a sincronizar', async () => {
    const store = createStore({
      Venta: [venta()], Producto: [{ id: 10, tipo: 'macbook' }],
      VentaAdelanto: [{ id: 5, productoId: 10, ventaId: 1, completadoAt: new Date(), canceladoAt: null, montoAdelanto: 500, fechaAdelanto: '2026-05-01',
        cuotas: [{ fecha: '2026-05-01', monto: 300 }, { fecha: '2026-05-03', monto: 200, pagoId: 3 }] }],
      Gasto: [ingreso(1, { monto: '2500.00' }), ingreso(2, { monto: '300.00', notas: '__SALE_ADVANCE__:5:0' }), ingreso(3, { monto: '200.00', saleId: null, notas: '__SALE_ADVANCE__:5:1' }),
        ingreso(4, { saleId: null, notas: '__SALE_ADVANCE__:50:0' })],
      VentaPago: [pago(1, { montoPen: '2500.00' }), pago(2, { adelantoId: 5, montoPen: '300.00', origen: 'adelanto', esAdelanto: true, idempotencyKey: 'adelanto:5:0' }),
        pago(3, { adelantoId: 5, ventaId: null, montoPen: '200.00', origen: 'manual', esAdelanto: true })],
    });
    const ledger = new FinanzasLedgerService({ manager: store.manager } as any);
    const { service } = createService(store, ledger);

    await service.anular(1, 7);

    expect(store.rows(VentaAdelanto)[0]).toMatchObject({ canceladoAt: expect.any(Date), ventaId: 1, motivoCancelacion: expect.stringContaining('anulada') });
    expect(store.rows(Gasto).map((g) => g.id)).toEqual([4]);
    expect(store.rows(VentaPago).every((p) => p.anuladoAt)).toBe(true);

    // Sincronizaciones posteriores no reactivan pagos ni recrean ingresos.
    await ledger.sincronizarAdelanto(5, store.manager);
    await ledger.sincronizarIngresosVenta(1, store.manager, { parts: [{ type: 'direct', amount: 2500 }] });
    expect(store.rows(VentaPago).every((p) => p.anuladoAt)).toBe(true);
    expect(store.rows(VentaPago)).toHaveLength(3);
    await (service as any).syncSaleIncomeRows(store.rows(Venta)[0], 'bcp', 'direct');
    expect(store.rows(Gasto).map((g) => g.id)).toEqual([4]);
    await expect(service.addAdelantoCuota(5, { fechaCuota: '2026-06-01', montoCuota: 10 } as any)).rejects.toThrow('cancelada');
  });

  it('repone exactamente las unidades de cada lote original', async () => {
    const store = createStore({
      Venta: [venta({ productoId: 20, cantidad: 3, distribucionStock: [{ productoId: 20, cantidad: 2 }, { productoId: 21, cantidad: 1 }], notas: undefined })],
      Producto: [{ id: 20, tipo: 'accesorios', stockActual: 0, stockInicial: 2 }, { id: 21, tipo: 'accesorios', stockActual: 4, stockInicial: 5 }],
      Gasto: [ingreso(1, { notas: '__SALE_INCOME__:20:1' })],
    });
    const { service } = createService(store);

    await service.anular(1, 7);

    expect(store.rows(Producto).map((p) => [p.id, p.stockActual])).toEqual([[20, 2], [21, 5]]);
    expect(store.manager.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [[20, 21]]);
  });

  it('con una devolución previa no repone dos veces ni duplica el ajuste financiero', async () => {
    const store = createStore({
      Venta: [venta({ productoId: 20, cantidad: 3, cantidadDevuelta: 1, precioDevuelto: 80, distribucionStock: [{ productoId: 20, cantidad: 2 }, { productoId: 21, cantidad: 1 }] })],
      Producto: [{ id: 20, tipo: 'accesorios', stockActual: 1, stockInicial: 2 }, { id: 21, tipo: 'accesorios', stockActual: 4, stockInicial: 5 }],
      VentaDevolucion: [{ id: 1, ventaId: 1, cantidad: 1, lotes: [{ productoId: 20, cantidad: 1, costoUnitario: 70 }] }],
      Gasto: [ingreso(1, { monto: '240.00', notas: '__SALE_INCOME__:20:1' }),
        ingreso(2, { concepto: 'devolucion_venta', monto: '80.00', notas: '__REFUND__:VENTA:1:1' }),
        ingreso(3, { concepto: 'devolucion_venta', saleId: 99, monto: '50.00', notas: '__REFUND__:VENTA:99:1' })],
      VentaPago: [pago(1, { montoPen: '240.00', estado: 'disponible' })],
      PagoLiquidacion: [{ id: 1, pagoId: 1, tipo: 'devolucion', fecha: '2026-05-11', montoBruto: '80.00', comision: '0', montoNeto: '80.00', cuentaId: 1 }],
    });
    const { service } = createService(store);

    await service.anular(1, 7);

    expect(store.rows(Producto).map((p) => [p.id, p.stockActual])).toEqual([[20, 2], [21, 5]]);
    expect(store.rows(Gasto).map((g) => g.id)).toEqual([3]);
    expect(store.rows(VentaPago)[0].anuladoAt).toBeInstanceOf(Date);
    expect(store.rows(VentaDevolucion)).toHaveLength(1);
  });

  it('es idempotente: un reintento no repite ajustes', async () => {
    const store = createStore({
      Venta: [venta({ productoId: 20, cantidad: 1 })], Producto: [{ id: 20, tipo: 'accesorios', stockActual: 0, stockInicial: 1 }],
      Gasto: [ingreso(1, { notas: '__SALE_INCOME__:20:1' })], VentaPago: [pago(1)],
    });
    const { service } = createService(store);

    const first = await service.anular(1, 7);
    const writes = store.writes.length;
    const second = await service.anular(1, 7);

    expect(second.anuladaAt).toEqual(first.anuladaAt);
    expect(store.writes.length).toBe(writes);
    expect(store.rows(Producto)[0].stockActual).toBe(1);
  });

  it('revierte toda la operación si falla el libro financiero', async () => {
    const store = createStore({
      Venta: [venta({ productoId: 20 })], Producto: [{ id: 20, tipo: 'accesorios', stockActual: 0, stockInicial: 1 }],
      Gasto: [ingreso(1, { notas: '__SALE_INCOME__:20:1' })], VentaPago: [pago(1)],
    });
    const ledger: any = { anularPagosVenta: jest.fn(async () => { throw new Error('fallo del libro'); }) };
    const { service } = createService(store, ledger);

    await expect(service.anular(1, 7)).rejects.toThrow('fallo del libro');

    expect(store.rows(Venta)[0]).toMatchObject({ estadoComercial: 'entregada' });
    expect(store.rows(Venta)[0].anuladaAt).toBeUndefined();
    expect(store.rows(Producto)[0].stockActual).toBe(0);
    expect(store.rows(Gasto)).toHaveLength(1);
  });

  it('no anula una venta ya devuelta por completo ni permite eliminar una anulada', async () => {
    const store = createStore({ Venta: [venta({ estadoComercial: 'cancelada' }), venta({ id: 2, anuladaAt: new Date(), estadoComercial: 'cancelada' })],
      Producto: [{ id: 10, tipo: 'macbook' }] });
    const { service } = createService(store);
    await expect(service.anular(1, 7)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.remove(2, 'corrección')).rejects.toThrow('anulada');
  });
});
