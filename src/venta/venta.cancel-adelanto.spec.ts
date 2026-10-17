import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VentaService } from './venta.service';
import { VentaAdelanto } from './venta-adelanto.entity';
import { Gasto } from '../gastos/entities/gasto.entity';

describe('VentaService.cancelAdelanto', () => {
  const setup = (adelanto: Partial<VentaAdelanto> | null) => {
    const advanceRepo = {
      findOne: jest.fn(async () => adelanto),
      remove: jest.fn(async () => undefined),
    };
    const incomeRepo = {
      find: jest.fn(async () => [{ id: 10 }, { id: 11 }]),
      remove: jest.fn(async () => undefined),
    };
    const manager = {
      getRepository: jest.fn((entity) => entity === VentaAdelanto ? advanceRepo : entity === Gasto ? incomeRepo : null),
    };
    const transaction = jest.fn(async (callback) => callback(manager));
    const cache = { del: jest.fn(async () => undefined) };
    const service = new VentaService(
      {} as any,
      { manager: { transaction } } as any,
      {} as any,
      {} as any,
      cache as any,
    );
    return { service, advanceRepo, incomeRepo, transaction, cache };
  };

  it('elimina el adelanto pendiente y solo sus ingresos dentro de una transacción', async () => {
    const adelanto = { id: 4, productoId: 9, completadoAt: null, ventaId: null };
    const { service, advanceRepo, incomeRepo, transaction, cache } = setup(adelanto);

    await service.cancelAdelanto(4);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(incomeRepo.find).toHaveBeenCalledWith({
      where: { concepto: 'ingreso', notas: expect.objectContaining({ _value: '__SALE_ADVANCE__:4:%' }) },
    });
    expect(incomeRepo.remove).toHaveBeenCalledWith([{ id: 10 }, { id: 11 }]);
    expect(advanceRepo.remove).toHaveBeenCalledWith(adelanto);
    expect(cache.del).toHaveBeenCalledWith('productos:stats');
  });

  it('no cancela una venta ya completada', async () => {
    const { service, advanceRepo, incomeRepo } = setup({ id: 4, ventaId: 7 });
    await expect(service.cancelAdelanto(4)).rejects.toBeInstanceOf(BadRequestException);
    expect(incomeRepo.remove).not.toHaveBeenCalled();
    expect(advanceRepo.remove).not.toHaveBeenCalled();
  });

  it('avisa si el adelanto no existe', async () => {
    const { service } = setup(null);
    await expect(service.cancelAdelanto(4)).rejects.toBeInstanceOf(NotFoundException);
  });
});
