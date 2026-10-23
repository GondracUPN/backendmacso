import { VentaService } from './venta.service';

describe('lectura de ultimos adelantos', () => {
  it('resume varias reservas con cuatro consultas, sin N+1', async () => {
    const adelantos = [1, 2, 3].map((id) => ({ id, productoId: id, ventaId: id,
      montoVenta: '100', montoAdelanto: '25', fechaAdelanto: '2026-10-01', cuotas: [] }));
    const adelantoRepo: any = { find: jest.fn().mockResolvedValue(adelantos) };
    const productoRepo: any = { find: jest.fn().mockResolvedValue(adelantos.map((item) => ({ id: item.id, tipo: 'iphone' }))) };
    const ventaRepo: any = { find: jest.fn().mockResolvedValue(adelantos.map((item) => ({ id: item.id, precioVenta: '100', fechaVenta: '2026-10-02' }))) };
    const gastoRepo: any = { find: jest.fn().mockResolvedValue([]) };
    const service = new VentaService(ventaRepo, adelantoRepo, productoRepo, {} as any, {} as any, gastoRepo);
    const result = await service.resumenAdelantos([1, 2, 3]);
    expect(result.map((row) => [row.id, row.precio, row.cobrado, row.falta])).toEqual([[1, 100, 25, 75], [2, 100, 25, 75], [3, 100, 25, 75]]);
    for (const repo of [adelantoRepo, productoRepo, ventaRepo, gastoRepo]) expect(repo.find).toHaveBeenCalledTimes(1);
  });
  it('atribuye los cierres históricos a su reserva en el resumen por lotes', async () => {
    const adelantoRepo: any = { find: jest.fn().mockResolvedValue([
      { id: 10, productoId: 279, ventaId: 405, montoVenta: 2600, montoAdelanto: 1950, fechaAdelanto: '2026-06-27', cuotas: [] },
      { id: 11, productoId: 280, ventaId: 406, montoVenta: 1000, montoAdelanto: 100, fechaAdelanto: '2026-06-27', cuotas: [] },
    ]) };
    const productoRepo: any = { find: jest.fn().mockResolvedValue([]) };
    const ventaRepo: any = { find: jest.fn().mockResolvedValue([{ id: 405, precioVenta: 2600, fechaVenta: '2026-09-11' }, { id: 406, precioVenta: 1000, fechaVenta: '2026-09-11' }]) };
    const gastoRepo: any = { find: jest.fn().mockResolvedValue([{ id: 90, concepto: 'ingreso', metodoPago: 'debito', notas: '__SALE_INCOME__:279:405', saleId: null, monto: '650.00', fecha: '2026-09-11' }]) };
    const service = new VentaService(ventaRepo, adelantoRepo, productoRepo, {} as any, {} as any, gastoRepo);
    const result = await service.resumenAdelantos([10, 11]);
    expect(result.map((row) => [row.id, row.cobrado, row.falta])).toEqual([[10, 2600, 0], [11, 100, 900]]);
    for (const repo of [adelantoRepo, productoRepo, ventaRepo, gastoRepo]) expect(repo.find).toHaveBeenCalledTimes(1);
  });
  it('ejecuta una consulta sin sincronizar ingresos ni escribir en el ledger', async () => {
    const qb: any = {};
    for (const method of ['leftJoinAndSelect', 'where', 'andWhere', 'distinctOn', 'orderBy', 'addOrderBy']) qb[method] = () => qb;
    qb.getMany = jest.fn().mockResolvedValue([{ id: 1, productoId: 5 }]);
    const gastoRepo: any = { save: jest.fn() };
    const ledger: any = { sincronizarAdelanto: jest.fn() };
    const service = new VentaService({} as any, { createQueryBuilder: () => qb } as any,
      {} as any, {} as any, {} as any, gastoRepo, {} as any, ledger);
    expect(await service.findLatestAdelantosByProductos([5])).toEqual([{ id: 1, productoId: 5 }]);
    expect(qb.getMany).toHaveBeenCalledTimes(1);
    expect(gastoRepo.save).not.toHaveBeenCalled();
    expect(ledger.sincronizarAdelanto).not.toHaveBeenCalled();
  });
});
