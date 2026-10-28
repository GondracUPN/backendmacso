import { ProductoService } from './producto.service';
import { Producto } from './producto.entity';
import { ProductoValor } from './producto-valor.entity';
import { ProductoDetalle } from './producto-detalle.entity';
import { Venta } from '../venta/venta.entity';
import { VentaAdelanto } from '../venta/venta-adelanto.entity';
import { VentaDevolucion } from '../venta/venta-devolucion.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { VentaPago } from '../finanzas/entities/venta-pago.entity';
import { PagoLiquidacion } from '../finanzas/entities/pago-liquidacion.entity';
import { Reembolso } from '../finanzas/entities/reembolso.entity';
import { ReembolsoEvento } from '../finanzas/entities/reembolso-evento.entity';
import { Tracking } from '../tracking/tracking.entity';
import { Inventario } from '../inventario/inventario.entity';
import { AccesorioVinculoAuditoria, AccesorioVinculoPropuesta } from '../accesorios/accesorio-vinculo.entity';
import { createStore } from '../venta/memory-store.test-helper';

const service = (store: ReturnType<typeof createStore>) => {
  const m = store.manager;
  const cache = { del: jest.fn(async () => undefined), get: jest.fn(), set: jest.fn() };
  return new ProductoService({ ...m.getRepository(Producto), manager: m } as any, m.getRepository(ProductoDetalle),
    m.getRepository(ProductoValor), m.getRepository(Tracking), m.getRepository(Venta), {} as any, m.getRepository(Inventario), cache as any);
};

const producto = (id: number, over: any = {}) => ({ id, tipo: 'macbook', stockInicial: 1, stockActual: 1, valorId: id, detalleId: id, ...over });
const valor = (id: number, over: any = {}) => ({ id, valorProducto: 600, valorSoles: 2220, costoTotal: 2300, peso: 1, valorDec: 0, ...over });
const gasto = (id: number, over: any = {}) => ({ id, concepto: 'ingreso', metodoPago: 'debito', userId: 1, monto: '100.00', fecha: '2026-05-10', saleId: null, notas: null, ...over });

/** Ninguna fila restante apunta a los registros borrados. */
function expectSinHuerfanos(store: ReturnType<typeof createStore>, productoId: number, ventaIds: number[], adelantoIds: number[]) {
  const ventas = new Set(store.rows(Venta).map((v) => v.id));
  const pagos = new Set(store.rows(VentaPago).map((p) => p.id));
  const gastos = new Set(store.rows(Gasto).map((g) => g.id));
  expect(store.rows(Producto).some((p) => p.id === productoId)).toBe(false);
  for (const entity of [Venta, VentaAdelanto, Reembolso, Tracking, Inventario, AccesorioVinculoAuditoria, AccesorioVinculoPropuesta]) {
    expect(store.rows(entity).filter((row) => row.productoId === productoId)).toEqual([]);
  }
  expect(store.rows(VentaDevolucion).filter((d) => !ventas.has(d.ventaId))).toEqual([]);
  expect(store.rows(PagoLiquidacion).filter((l) => !pagos.has(l.pagoId))).toEqual([]);
  expect(store.rows(VentaPago).filter((p) => ventaIds.includes(p.ventaId) || adelantoIds.includes(p.adelantoId))).toEqual([]);
  expect(store.rows(Gasto).filter((g) => ventaIds.includes(g.saleId) || ventaIds.includes(g.ventaVinculadaId) || g.productoVinculadoId === productoId
    || adelantoIds.some((a) => String(g.notas || '').startsWith(`__SALE_ADVANCE__:${a}:`)) || (g.itfIngresoId && !gastos.has(g.itfIngresoId)))).toEqual([]);
  expect(store.rows(AccesorioVinculoPropuesta).filter((p) => (p.productoIds || []).includes(productoId))).toEqual([]);
}

describe('ProductoService.remove (borrado definitivo)', () => {
  it('sin historial: borra producto, valor, detalle, tracking e inventario y recalcula el grupo de envío', async () => {
    const store = createStore({
      Producto: [producto(1, { envioGrupoId: 'g1' }), producto(2, { envioGrupoId: 'g1' })],
      ProductoValor: [valor(1, { costoEnvioProrrateado: 20 }), valor(2, { costoEnvioProrrateado: 20, costoTotalProrrateado: 2240 })],
      ProductoDetalle: [{ id: 1 }, { id: 2 }], Tracking: [{ id: 1, productoId: 1 }], Inventario: [{ id: 1, productoId: 1 }],
    });

    const resumen = await service(store).remove(1);

    expect(resumen).toMatchObject({ productoId: 1, ventas: 0, pagos: 0, gastos: 0 });
    expect(store.rows(ProductoValor).map((v) => v.id)).toEqual([2]);
    expect(store.rows(ProductoDetalle).map((v) => v.id)).toEqual([2]);
    expect(store.rows(Tracking)).toEqual([]);
    expect(store.rows(Inventario)).toEqual([]);
    // El otro producto queda solo: el grupo se disuelve dentro de la misma transacción.
    expect(store.rows(Producto)[0]).toMatchObject({ id: 2, envioGrupoId: null });
    expect(store.rows(ProductoValor)[0]).toMatchObject({ costoEnvioProrrateado: null, costoTotalProrrateado: null });
    expect(store.manager.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock('), ['accesorios:topologia']);
    expectSinHuerfanos(store, 1, [], []);
  });

  it('con venta cobrada: retira ingresos, ITF, pagos, liquidaciones y gastos exclusivos; conserva los ajenos y compartidos', async () => {
    const store = createStore({
      Producto: [producto(1)], ProductoValor: [valor(1)], ProductoDetalle: [{ id: 1 }],
      Venta: [{ id: 10, productoId: 1, cantidad: 1, estadoComercial: 'entregada' }],
      VentaDevolucion: [],
      Gasto: [
        gasto(1, { saleId: 10, notas: '__SALE_INCOME__:1:10:direct' }),
        gasto(2, { saleId: 10, notas: '__SALE_INCOME__:1:10:card', salePaymentType: 'card' }),
        gasto(3, { concepto: 'itf', itfIngresoId: 1 }),
        gasto(4, { concepto: 'envio', metodoPago: 'credito', ventaVinculadaId: 10 }),
        gasto(5, { concepto: 'reparacion', productoVinculadoId: 1 }),
        gasto(6, { concepto: 'compra', metodoPago: 'credito', productoVinculadoId: 1, cuotasMeses: 6 }),
        gasto(7, { concepto: 'compra', productoVinculadoId: 1, ventaVinculadaId: 99 }),
        gasto(8, { concepto: 'ingreso', notas: 'ingreso libre' }),
        gasto(9, { saleId: 11, notas: '__SALE_INCOME__:2:11' }),
      ],
      VentaPago: [{ id: 1, ventaId: 10, adelantoId: null }, { id: 2, ventaId: 10, adelantoId: null }, { id: 3, ventaId: 11, adelantoId: null }],
      PagoLiquidacion: [{ id: 1, pagoId: 2, tipo: 'liquidacion' }, { id: 2, pagoId: 3, tipo: 'liquidacion' }],
    });

    const resumen = await service(store).remove(1);

    expect(resumen).toMatchObject({ ventas: 1, pagos: 2, liquidaciones: 1, gastos: 5, gastosDesvinculados: 2 });
    expect(store.rows(Gasto).map((g) => g.id)).toEqual([6, 7, 8, 9]);
    expect(store.rows(Gasto).find((g) => g.id === 6)).toMatchObject({ productoVinculadoId: null, cuotasMeses: 6 });
    expect(store.rows(Gasto).find((g) => g.id === 7)).toMatchObject({ productoVinculadoId: null, ventaVinculadaId: 99 });
    expect(store.rows(VentaPago).map((p) => p.id)).toEqual([3]);
    expect(store.rows(PagoLiquidacion).map((l) => l.id)).toEqual([2]);
    expectSinHuerfanos(store, 1, [10], []);
  });

  it('con reservas activa y completada: borra adelantos, sus ingresos y pagos', async () => {
    const store = createStore({
      Producto: [producto(1)], ProductoValor: [valor(1)], ProductoDetalle: [{ id: 1 }],
      Venta: [{ id: 10, productoId: 1, cantidad: 1, estadoComercial: 'entregada' }],
      VentaAdelanto: [{ id: 5, productoId: 1, ventaId: 10, completadoAt: new Date() }, { id: 6, productoId: 1, ventaId: null, canceladoAt: new Date() }],
      Gasto: [gasto(1, { saleId: 10, notas: '__SALE_ADVANCE__:5:0' }), gasto(2, { notas: '__SALE_ADVANCE__:6:0' }),
        gasto(3, { notas: '__SALE_ADVANCE__:60:0' }), gasto(4, { notas: '__SALE_INCOME__:1' })],
      VentaPago: [{ id: 1, ventaId: 10, adelantoId: 5 }, { id: 2, ventaId: null, adelantoId: 6 }, { id: 3, ventaId: null, adelantoId: 60 }],
    });

    const resumen = await service(store).remove(1);

    expect(resumen).toMatchObject({ ventas: 1, adelantos: 2, pagos: 2, gastos: 3 });
    expect(store.rows(Gasto).map((g) => g.id)).toEqual([3]);
    expect(store.rows(VentaPago).map((p) => p.id)).toEqual([3]);
    expectSinHuerfanos(store, 1, [10], [5, 6]);
  });

  it('con reembolso: borra el reclamo, sus eventos y el crédito generado en Gastos', async () => {
    const store = createStore({
      Producto: [producto(1)], ProductoValor: [valor(1)], ProductoDetalle: [{ id: 1 }],
      Reembolso: [{ id: 3, productoId: 1 }, { id: 4, productoId: 2 }],
      ReembolsoEvento: [{ id: 1, reembolsoId: 3, gastoId: 1 }, { id: 2, reembolsoId: 3, gastoId: null }, { id: 3, reembolsoId: 4, gastoId: 2 }],
      Gasto: [gasto(1, { metodoPago: 'credito', notas: '__REFUND__:3', productoVinculadoId: 1 }), gasto(2, { metodoPago: 'credito', notas: '__REFUND__:4', productoVinculadoId: 2 })],
    });

    const resumen = await service(store).remove(1);

    expect(resumen).toMatchObject({ reembolsos: 1, reembolsoEventos: 2, gastos: 1 });
    expect(store.rows(Reembolso).map((r) => r.id)).toEqual([4]);
    expect(store.rows(ReembolsoEvento).map((r) => r.id)).toEqual([3]);
    expect(store.rows(Gasto).map((g) => g.id)).toEqual([2]);
    expectSinHuerfanos(store, 1, [], []);
  });

  it('lotes compartidos: repone otros lotes sin duplicar y conserva ventas independientes con su costo', async () => {
    const lote = (id: number, stock: number) => producto(id, { tipo: 'accesorios', stockInicial: 5, stockActual: stock });
    const store = createStore({
      Producto: [lote(1, 2), lote(2, 0)], ProductoValor: [valor(1, { costoTotal: 50, valorSoles: 50 }), valor(2, { costoTotal: 50 })],
      ProductoDetalle: [{ id: 1 }, { id: 2 }],
      Venta: [
        // Vendida desde el lote borrado, tomó 2 del lote 2 (1 ya devuelta).
        { id: 10, productoId: 1, cantidad: 3, distribucionStock: [{ productoId: 1, cantidad: 1 }, { productoId: 2, cantidad: 2 }] },
        // Ya anulada: su stock ya se repuso.
        { id: 11, productoId: 1, cantidad: 1, anuladaAt: new Date(), estadoComercial: 'cancelada', distribucionStock: [{ productoId: 2, cantidad: 1 }] },
        // Independiente: vendida desde el lote 2, tomó una unidad del lote borrado.
        { id: 12, productoId: 2, cantidad: 2, distribucionStock: [{ productoId: 2, cantidad: 1, costoUnitario: 10 }, { productoId: 1, cantidad: 1 }] },
      ],
      VentaDevolucion: [{ id: 1, ventaId: 10, cantidad: 1, lotes: [{ productoId: 2, cantidad: 1, costoUnitario: 10 }] }],
      Gasto: [gasto(1, { saleId: 12, notas: '__SALE_INCOME__:2:12' })],
      VentaPago: [{ id: 1, ventaId: 12, adelantoId: null }],
      AccesorioVinculoPropuesta: [{ id: 1, productoId: 1, productoIds: [1, 2], estado: 'pendiente' }, { id: 2, productoId: 1, productoIds: [1], estado: 'aceptada' }],
      AccesorioVinculoAuditoria: [{ id: 1, productoId: 1, loteId: 2 }, { id: 2, productoId: 1, revierteAuditoriaId: 1 }, { id: 3, productoId: 2, loteId: 1 }],
    });

    const resumen = await service(store).remove(1);

    expect(resumen).toMatchObject({ ventas: 2, devoluciones: 1, unidadesRepuestas: 1, ventasCompartidasConservadas: 1 });
    expect(store.rows(Producto)).toEqual([expect.objectContaining({ id: 2, stockActual: 1 })]);
    const independiente = store.rows(Venta).find((v) => v.id === 12);
    expect(independiente.distribucionStock).toEqual([{ productoId: 2, cantidad: 1, costoUnitario: 10 }, { productoId: 1, cantidad: 1, costoUnitario: 10 }]);
    expect(store.rows(Gasto).map((g) => g.id)).toEqual([1]);
    expect(store.rows(VentaPago).map((p) => p.id)).toEqual([1]);
    expect(store.rows(AccesorioVinculoPropuesta)).toEqual([expect.objectContaining({ id: 1, productoId: 2, productoIds: [2], estado: 'obsoleta' })]);
    expect(store.rows(AccesorioVinculoAuditoria)).toEqual([expect.objectContaining({ id: 3, productoId: 2, loteId: 1 })]);
    expectSinHuerfanos(store, 1, [10, 11], []);
  });

  it('un fallo en cualquier paso revierte todo el borrado', async () => {
    const seed = {
      Producto: [producto(1, { tipo: 'accesorios', stockInicial: 5, stockActual: 2 }), producto(2, { tipo: 'accesorios', stockInicial: 5, stockActual: 0 })],
      ProductoValor: [valor(1), valor(2)], ProductoDetalle: [{ id: 1 }, { id: 2 }],
      Venta: [{ id: 10, productoId: 1, cantidad: 2, distribucionStock: [{ productoId: 2, cantidad: 2 }] }],
      Gasto: [gasto(1, { saleId: 10 })], VentaPago: [{ id: 1, ventaId: 10, adelantoId: null }], PagoLiquidacion: [{ id: 1, pagoId: 1 }],
    };
    const store = createStore(seed, { failOn: 'delete:Producto' });

    await expect(service(store).remove(1)).rejects.toThrow('fallo inyectado');

    expect(store.rows(Producto).map((p) => [p.id, p.stockActual])).toEqual([[1, 2], [2, 0]]);
    expect(store.rows(Venta)).toHaveLength(1);
    expect(store.rows(Gasto)).toHaveLength(1);
    expect(store.rows(VentaPago)).toHaveLength(1);
    expect(store.rows(PagoLiquidacion)).toHaveLength(1);
  });

  it('avisa si el producto no existe', async () => {
    await expect(service(createStore()).remove(1)).rejects.toThrow('no encontrado');
  });
});
