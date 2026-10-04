import { VentaService } from './venta.service';

describe('cobro de venta del catálogo', () => {
  it('registra completo el ingreso directo desde la fecha de venta', async () => {
    const gastoRepo = {
      find: jest.fn(async () => []),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    const service = new VentaService({} as any, {} as any, { findOne: jest.fn(async () => ({ tipo: 'macbook' })) } as any, {} as any, {} as any, gastoRepo as any, { findOne: jest.fn(async () => ({ id: 1 })) } as any);
    await (service as any).syncSaleIncome({ id: 7, productoId: 44, vendedor: 'Gonzalo', precioVenta: 5200, fechaVenta: '2026-10-02' }, 'bcp', 'direct', 'MS-44');
    expect(gastoRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      salePaymentType: 'direct', saleReceivedAmount: '5200.00', salePaidAt: '2026-10-02', saleSku: 'MS-44',
    }));
  });
  it('actualiza el avance x500 y el tipo de cambio en la venta', async () => {
    const income = {
      id: 31, saleId: 7, salePaymentType: 'debt', saleReceivedAmount: '0.00',
      monto: '5200.00', cantidad500: 0, salePaidAt: null,
    };
    const gastoRepo = {
      findOne: jest.fn(async () => income),
      save: jest.fn(async (value) => value),
    };
    const service = new VentaService({} as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any);
    const update = jest.spyOn(service, 'update').mockResolvedValue({ id: 7 } as any);

    const result = await service.updateSaleIncomePayment(31, {
      receivedAmount: 1200, paidAt: '2026-10-02', exchangeRate: 3.8,
    });

    expect(update).toHaveBeenCalledWith(7, { tipoCambio: 3.8 });
    expect(result).toMatchObject({ saleReceivedAmount: '1200.00', cantidad500: 2, salePaidAt: '2026-10-02' });
  });

  it('suma solo el importe registrado de un pago con tarjeta', async () => {
    const income = { id: 32, saleId: 8, salePaymentType: 'card', monto: '1800.00', saleReceivedAmount: '0.00' };
    const gastoRepo = { findOne: jest.fn(async () => income), save: jest.fn(async (value) => value) };
    const service = new VentaService({} as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any);
    await expect(service.updateSaleIncomePayment(32, { receivedAmount: 0, paidAt: '2026-10-02' })).rejects.toThrow(/Registra un monto recibido/);
    const result = await service.updateSaleIncomePayment(32, { receivedAmount: 800, paidAt: '2026-10-02' });
    expect(result).toMatchObject({ saleReceivedAmount: '800.00', salePaidAt: '2026-10-02' });
  });

  it('elimina el ingreso vinculado cuando se anula la venta', async () => {
    const sale = { id: 8, productoId: 44, producto: { tipo: 'macbook' } };
    const income = { id: 32, saleId: 8 };
    const ventaRepo = { findOne: jest.fn(async () => sale), remove: jest.fn(async () => sale) };
    const gastoRepo = { find: jest.fn(async () => [income]), remove: jest.fn(async () => [income]) };
    const service = new VentaService(ventaRepo as any, {} as any, {} as any, {} as any, { del: jest.fn(async () => undefined) } as any, gastoRepo as any);
    await service.remove(8);
    expect(gastoRepo.find).toHaveBeenCalledWith({ where: { saleId: 8 } });
    expect(gastoRepo.remove).toHaveBeenCalledWith([income]);
  });
});
