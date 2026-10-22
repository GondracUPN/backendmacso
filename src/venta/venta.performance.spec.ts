import { VentaService } from './venta.service';

describe('lectura de ultimos adelantos', () => {
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
