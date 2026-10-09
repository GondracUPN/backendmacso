import { VentaService } from './venta.service';

describe('cobro de venta del catálogo', () => {
  it('consulta todos los cobros por el ID de venta, incluso si están repartidos entre vendedores', async () => {
    const gastoRepo = { find: jest.fn(async () => [
      { saleId: 12, saleSku: 'MS-340', salePaymentType: 'direct', monto: '1500.00', saleReceivedAmount: '1500.00', tarjeta: 'bcp' },
      { saleId: 12, saleSku: 'MS-340', salePaymentType: 'direct', monto: '1500.00', saleReceivedAmount: '1500.00', tarjeta: 'bcp' },
      { saleId: 12, saleSku: 'MS-340', salePaymentType: 'cash', monto: '1000.00', saleReceivedAmount: '1000.00', tarjeta: 'efectivo' },
    ]) };
    const service = new VentaService({} as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 12, productoId: 340, precioVenta: 4000, fechaVenta: '2026-10-08', tipoCambio: 3.7 } as any);
    expect(await service.getSalePayments(12)).toMatchObject({ saleId: 12, sku: 'MS-340', amount: 4000,
      parts: [{ type: 'direct', amount: 3000, received: 3000 }, { type: 'cash', amount: 1000, received: 1000 }] });
    expect(gastoRepo.find).toHaveBeenCalledWith({ where: { saleId: 12, concepto: 'ingreso' } });
  });

  it('permite corregir un pago directo en efectivo y conserva el ID de venta en ambos ingresos', async () => {
    const original = { id: 5, userId: 1, saleId: 12, notas: '__SALE_INCOME__:340:direct', salePaymentType: 'direct', monto: '4000.00', saleReceivedAmount: '4000.00' };
    const saved: any[] = [];
    const gastoRepo = { find: jest.fn(async () => [original]), create: jest.fn((value) => value),
      save: jest.fn(async (value) => { saved.push({ ...value }); return { id: value.id || 6, ...value }; }), remove: jest.fn() };
    const service = new VentaService({} as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any, { findOne: jest.fn(async () => ({ id: 1 })) } as any);
    await (service as any).syncSaleIncome({ id: 12, productoId: 340, vendedor: 'Gonzalo', precioVenta: 4000, fechaVenta: '2026-10-08' }, 'bcp', undefined, 'MS-340', [
      { type: 'direct', amount: 3000 }, { type: 'cash', amount: 1000 },
    ]);
    expect(saved.map((row) => [row.saleId, row.salePaymentType, row.monto, row.saleReceivedAmount])).toEqual([
      [12, 'direct', '3000.00', '3000.00'], [12, 'cash', '1000.00', '1000.00'],
    ]);
    expect(saved[0].notas).toBe('__SALE_INCOME__:340:12:direct');
  });

  it('mantiene editable el importe de una venta antigua con un solo cobro', async () => {
    const original = { id: 5, userId: 1, saleId: 12, notas: '__SALE_INCOME__:340', salePaymentType: 'direct', monto: '4000.00', saleReceivedAmount: '4000.00' };
    const gastoRepo = { find: jest.fn(async () => [original]), save: jest.fn(async (value) => value), remove: jest.fn() };
    const service = new VentaService({} as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any, { findOne: jest.fn(async () => ({ id: 1 })) } as any);
    await (service as any).syncSaleIncome({ id: 12, productoId: 340, vendedor: 'Gonzalo', precioVenta: 4200, fechaVenta: '2026-10-08' }, 'bcp');
    expect(gastoRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 5, saleId: 12, monto: '4200.00', saleReceivedAmount: '4200.00' }));
  });

  it('rechaza bajar un cobro ya recibido antes de guardar la venta', async () => {
    const ventaRepo = { save: jest.fn() };
    const gastoRepo = { find: jest.fn(async () => [{ salePaymentType: 'card', saleReceivedAmount: '4000.00' }]) };
    const service = new VentaService(ventaRepo as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 12, precioVenta: 4000 } as any);
    await expect(service.update(12, { precioVenta: 3900, incomeBank: 'bcp', incomeParts: [{ type: 'card', amount: 3900 }] } as any))
      .rejects.toThrow(/menor que los pagos ya recibidos/);
    expect(ventaRepo.save).not.toHaveBeenCalled();
  });
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
  it('aplica pagos combinados solo al saldo final de una venta con adelantos', async () => {
    const saved: any[] = [];
    const gastoRepo = { find: jest.fn(async () => []), create: jest.fn((value) => value), save: jest.fn(async (value) => { saved.push(value); return { id: saved.length, ...value }; }) };
    const advanceRepo = { findOne: jest.fn(async () => ({ ventaId: 7, montoAdelanto: 800 })) };
    const service = new VentaService({} as any, advanceRepo as any, { findOne: jest.fn(async () => ({ tipo: 'macbook' })) } as any, {} as any, {} as any, gastoRepo as any, { findOne: jest.fn(async () => ({ id: 1 })) } as any);
    await (service as any).syncSaleIncome({ id: 7, productoId: 44, vendedor: 'Gonzalo', precioVenta: 2000, fechaVenta: '2026-10-07' }, 'bcp', 'direct', 'MS-44', [
      { type: 'direct', amount: 200 }, { type: 'card', amount: 1000 },
    ]);
    expect(saved.map((row) => [row.salePaymentType, row.monto, row.saleReceivedAmount])).toEqual([
      ['direct', '200.00', '200.00'], ['card', '1000.00', '0.00'],
    ]);
  });
  it('registra un lote x500 con fecha sin cambiar la venta hasta completar el saldo', async () => {
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
      paymentCount: 2, paidAt: '2026-10-02', exchangeRate: 3.8,
    });

    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ saleReceivedAmount: '1000.00', cantidad500: 2, salePaidAt: '2026-10-02', saleExchangeRate: '3.8000' });
    expect(result.salePaymentHistory).toEqual([{ amount: 1000, paidAt: '2026-10-02', units500: 2 }]);
  });

  it('suma pagos normales sin superar el saldo y conserva sus fechas', async () => {
    const income = { id: 32, saleId: 8, salePaymentType: 'card', monto: '1800.00', saleReceivedAmount: '0.00' };
    const gastoRepo = { findOne: jest.fn(async () => income), save: jest.fn(async (value) => value) };
    const service = new VentaService({} as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any);
    await expect(service.updateSaleIncomePayment(32, { paymentAmount: 0, paidAt: '2026-10-02' })).rejects.toThrow(/monto recibido válido/);
    await service.updateSaleIncomePayment(32, { paymentAmount: 800, paidAt: '2026-10-02' });
    await expect(service.updateSaleIncomePayment(32, { paymentAmount: 1001, paidAt: '2026-10-03' })).rejects.toThrow(/supera el saldo/);
    const result = await service.updateSaleIncomePayment(32, { paymentAmount: 1000, paidAt: '2026-10-03' });
    expect(result).toMatchObject({ saleReceivedAmount: '1800.00', salePaidAt: '2026-10-03' });
    expect(result.salePaymentHistory).toEqual([
      { amount: 800, paidAt: '2026-10-02' },
      { amount: 1000, paidAt: '2026-10-03' },
    ]);
  });

  it('permite cobrar un adelanto por tarjeta antes de completar la venta', async () => {
    const income = { id: 40, saleId: null, notas: '__SALE_ADVANCE__:5:0', salePaymentType: 'card', monto: '500.00', saleReceivedAmount: '0.00' };
    const gastoRepo = { findOne: jest.fn(async () => income), save: jest.fn(async (value) => value) };
    const service = new VentaService({} as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any);
    const result = await service.updateSaleIncomePayment(40, { paymentAmount: 200, paidAt: '2026-09-04' });
    expect(result).toMatchObject({ saleReceivedAmount: '200.00', salePaidAt: '2026-09-04' });
    expect(result.salePaymentHistory).toEqual([{ amount: 200, paidAt: '2026-09-04' }]);
  });

  it('aplica el tipo de cambio al completar y permite corregirlo después desde gastos', async () => {
    const income = { id: 33, saleId: 9, salePaymentType: 'card', monto: '1700.00', saleReceivedAmount: '900.00', salePaidAt: '2026-10-02', salePaymentHistory: [{ amount: 900, paidAt: '2026-10-02' }], saleExchangeRate: null as string | null, tasaUsdPen: null as string | null };
    const gastoRepo = { findOne: jest.fn(async () => income), save: jest.fn(async (value) => value) };
    const service = new VentaService({} as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 9, vendedor: 'Gonzalo' } as any);
    const update = jest.spyOn(service, 'update').mockResolvedValue({ id: 9 } as any);

    await service.updateSaleIncomePayment(33, { paymentAmount: 800, paidAt: '2026-10-05', exchangeRate: 3.7 });
    expect(update).toHaveBeenCalledWith(9, { tipoCambio: 3.7 });
    expect(income.saleExchangeRate).toBe('3.7000');

    await service.updateSaleIncomePayment(33, { exchangeRate: 3.8 });
    expect(update).toHaveBeenLastCalledWith(9, { tipoCambio: 3.8 });
    expect(income.tasaUsdPen).toBe('3.8000');
  });

  it('solo permite el último monto x500 cuando faltan menos de S/ 500', async () => {
    const income = { id: 34, saleId: 10, salePaymentType: 'debt', monto: '1200.00', saleReceivedAmount: '1000.00', cantidad500: 2, salePaidAt: '2026-10-02' };
    const gastoRepo = { findOne: jest.fn(async () => income), save: jest.fn(async (value) => value) };
    const service = new VentaService({} as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any);
    await expect(service.updateSaleIncomePayment(34, { paymentCount: 1, paidAt: '2026-10-03' })).rejects.toThrow(/cantidad de pagos/);
    const result = await service.updateSaleIncomePayment(34, { paymentAmount: 200, paidAt: '2026-10-03' });
    expect(result.saleReceivedAmount).toBe('1200.00');
    expect(result.salePaymentHistory).toHaveLength(2);
  });

  it('usa al cancelar x500 el tipo de cambio fijado en un abono anterior', async () => {
    const income = { id: 35, saleId: 11, salePaymentType: 'debt', monto: '1200.00', saleReceivedAmount: '1000.00', cantidad500: 2, saleExchangeRate: '3.7000', salePaymentHistory: [{ amount: 1000, paidAt: '2026-10-02', units500: 2 }] };
    const gastoRepo = { findOne: jest.fn(async () => income), save: jest.fn(async (value) => value) };
    const service = new VentaService({} as any, {} as any, {} as any, {} as any, {} as any, gastoRepo as any);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 11, vendedor: 'Renato' } as any);
    const update = jest.spyOn(service, 'update').mockResolvedValue({ id: 11 } as any);

    const result = await service.updateSaleIncomePayment(35, { paymentAmount: 200, paidAt: '2026-10-05' });

    expect(update).toHaveBeenCalledWith(11, { tipoCambio: 3.7 });
    expect(result.saleReceivedAmount).toBe('1200.00');
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
