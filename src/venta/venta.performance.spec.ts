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
