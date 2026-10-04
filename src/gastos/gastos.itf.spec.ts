import { GastosService, calculateIncomeItf } from './gastos.service';

describe('ITF en ingresos', () => {
  const makeService = () => {
    let nextId = 1;
    const repo = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ ...value, id: value.id || nextId++ })),
      findOne: jest.fn().mockResolvedValue(null),
      remove: jest.fn(),
      manager: { transaction: jest.fn() },
    };
    repo.manager.transaction.mockImplementation((callback) => callback({ getRepository: () => repo }));
    const service = new GastosService(repo as any, {} as any, {} as any, {} as any, {} as any);
    return { service, repo };
  };

  it('aplica 0.005 % solo al ingreso único en soles mayor de 1000', () => {
    expect(calculateIncomeItf(1000)).toBe(0);
    expect(calculateIncomeItf(1000.01)).toBe(0.05);
    expect(calculateIncomeItf(5000)).toBe(0.25);
    expect(calculateIncomeItf(5000, 10)).toBe(0);
  });

  it('guarda un gasto ITF vinculado al ingreso único', async () => {
    const { service, repo } = makeService();
    await service.create(7, {
      concepto: 'ingresos', metodoPago: 'debito', moneda: 'PEN', monto: 5000,
      fecha: '2026-10-02', tarjeta: 'bcp', allowDuplicate: true,
    } as any);
    expect(repo.save).toHaveBeenCalledTimes(2);
    expect(repo.save).toHaveBeenLastCalledWith(expect.objectContaining({
      concepto: 'itf', monto: '0.25', itfIngresoId: 1, userId: 7,
    }));
  });

  it('registra depósitos x500 parciales y a quién se entregaron sin ITF sobre el total', async () => {
    const { service, repo } = makeService();
    await service.create(7, {
      concepto: 'ingresos', metodoPago: 'debito', moneda: 'PEN', monto: 5000,
      cantidad500: 8, destinatario500: 'renato', fecha: '2026-10-02', tarjeta: 'bcp', allowDuplicate: true,
    } as any);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ cantidad500: 8, destinatario500: 'renato' }));
    await expect(service.create(7, {
      concepto: 'ingresos', metodoPago: 'debito', moneda: 'PEN', monto: 5000,
      cantidad500: 11, destinatario500: 'yo', fecha: '2026-10-02', allowDuplicate: true,
    } as any)).rejects.toThrow(/no puede superar/);
  });

  it('elimina el cargo vinculado cuando el ingreso editado queda en 1000', async () => {
    const { service, repo } = makeService();
    const ingreso = {
      id: 1, userId: 7, concepto: 'ingreso', metodoPago: 'debito', moneda: 'PEN',
      monto: '5000.00', montoPen: '5000.00', fecha: '2026-10-02', tarjeta: 'bcp', cantidad500: null,
    };
    const itf = { id: 2, concepto: 'itf', itfIngresoId: 1, monto: '0.25' };
    repo.findOne.mockImplementation(async ({ where }) => where.id === 1 ? ingreso : where.itfIngresoId === 1 ? itf : null);

    await service.update(7, 'admin' as any, 1, { monto: 1000 } as any);

    expect(repo.remove).toHaveBeenCalledWith(itf);
    expect(repo.manager.transaction).toHaveBeenCalledTimes(1);
  });

  it('elimina el ingreso y su ITF en la misma transacción', async () => {
    const { service, repo } = makeService();
    const ingreso = { id: 1, userId: 7, concepto: 'ingreso', metodoPago: 'debito', moneda: 'PEN', monto: '5000.00' };
    const itf = { id: 2, concepto: 'itf', itfIngresoId: 1, monto: '0.25' };
    repo.findOne.mockImplementation(async ({ where }) => where.id === 1 ? ingreso : where.itfIngresoId === 1 ? itf : null);

    await service.remove(7, 'admin' as any, 1);

    expect(repo.remove).toHaveBeenNthCalledWith(1, itf);
    expect(repo.remove).toHaveBeenNthCalledWith(2, ingreso);
    expect(repo.manager.transaction).toHaveBeenCalledTimes(1);
  });
});
