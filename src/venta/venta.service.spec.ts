import { VentaService } from './venta.service';
import { withTransactionMocks } from './venta-transaction.test-helper';
import { Producto } from '../producto/producto.entity';
import { appCacheKey, registerCacheInvalidation } from '../common/app-cache';
import { Inventario } from '../inventario/inventario.entity';

function quoteFixture() {
  const lots: any[] = [
    { id: 101, codigoInventario: 101, tipo: 'accesorios', vendedor: 'Gonzalo', stockInicial: 2, stockActual: 2, valor: { costoTotal: 20, fechaCompra: '2026-01-01' } },
    { id: 102, codigoInventario: 101, tipo: 'accesorios', vendedor: 'Gonzalo', stockInicial: 3, stockActual: 3, valor: { costoTotal: 45, fechaCompra: '2026-02-01' } },
    { id: 103, codigoInventario: 101, tipo: 'accesorios', vendedor: 'Renato', stockInicial: 9, stockActual: 9, valor: { costoTotal: 9, fechaCompra: '2025-01-01' } },
  ];
  const builder: any = {};
  for (const name of ['where', 'select', 'orderBy', 'setLock']) builder[name] = jest.fn(() => builder);
  builder.getOne = jest.fn(async () => lots[0]);
  builder.getRawMany = jest.fn(async () => lots.map((lot) => ({ id: lot.id })));
  const products: any = { findOne: jest.fn(async () => lots[0]), find: jest.fn(async () => lots),
    save: jest.fn(async (value) => value), createQueryBuilder: jest.fn(() => builder) };
  const recorded: any[] = [];
  const sales: any = { find: jest.fn(async () => recorded), findOne: jest.fn(async () => null), create: jest.fn((value) => value), save: jest.fn(async (value) => { const saved = { id: 200, ...value }; recorded.push(saved); return saved; }) };
  const inventory: any = { find: jest.fn(async () => [{ productoId: 101, primerPrecioSoles: 25, ultimoPrecioSoles: 18 }]) };
  const manager: any = { getRepository: (entity) => entity === Producto ? products : entity === Inventario ? inventory : sales,
    transaction: async (run) => run(manager) };
  products.manager = manager;
  const service = withTransactionMocks(new VentaService(sales, {} as any, products, {} as any, { del: jest.fn(async () => undefined) } as any));
  return { service, lots, products, inventory };
}

test.each([['PEN', 12], ['USD', 39]])('cotiza y vende accesorios simples %s con costo unitario convertido a 3.7 más envío', async (monedaCompra, unitCost) => {
  const { service, lots } = quoteFixture();
  Object.assign(lots[0], { soloInventario: true, valor: { valorProducto: 20, monedaCompra,
    valorSoles: 999, costoTotal: 999, costoTotalProrrateado: 999, costoEnvio: 4 } });
  const quote = await service.quoteAccessory({ productoId: 101, cantidad: 2, precioUnitario: 50 });
  expect(quote.costoTotal).toBe(Number(unitCost) * 2);
  expect(quote.precioMinimo).toBe(Math.ceil(Number(unitCost) * 1.3 * 2 - 1e-9) / 2);
  expect(quote.precioUnitarioSugerido).toBe(Math.ceil(Number(unitCost) * 1.5 * 2 - 1e-9) / 2);
  expect(quote.lotes).toEqual([{ productoId: 101, cantidad: 2, costoUnitario: unitCost }]);
  const sale = await service.create({ productoId: 101, cantidad: 2, tipoCambio: 1,
    fechaVenta: '2026-10-25', precioVenta: 100, cotizacionToken: quote.cotizacionToken });
  expect(sale.precioVenta - sale.ganancia).toBe(Number(unitCost) * 2);
});

test('accesorios con referencia y guía conservan precios guardados y sugerencia anterior al costo +30%', async () => {
  const { service, lots, inventory } = quoteFixture();
  Object.assign(lots[0], { soloInventario: true, referenciaId: 55, origen: 'accesorio_importado',
    tracking: [{ estado: 'recogido', fechaRecogido: '2026-10-25' }] });
  expect(await service.quoteAccessory({ productoId: 101, cantidad: 1 })).toMatchObject({
    precioMinimo: 18, precioUnitarioSugerido: 25,
  });
  inventory.find.mockResolvedValue([]);
  expect(await service.quoteAccessory({ productoId: 101, cantidad: 1 })).toMatchObject({
    precioMinimo: null, precioUnitarioSugerido: 13,
  });
});

test('cotizar 2 a S/10 y 3 a S/15 cuesta S/65 y vender conserva ese costo sin consumir al otro comprador', async () => {
  const { service, lots } = quoteFixture();
  const quote = await service.quoteAccessory({ productoId: 101, cantidad: 5, comprador: 'Gonzalo', precioUnitario: 25 });
  expect(quote).toMatchObject({ costoTotal: 65, total: 125, gananciaBruta: 60, margenSobreVenta: 48, precioMinimo: 18 });
  expect(quote.lotes).toEqual([{ productoId: 101, cantidad: 2, costoUnitario: 10 }, { productoId: 102, cantidad: 3, costoUnitario: 15 }]);
  expect(lots.map((lot) => lot.stockActual)).toEqual([2, 3, 9]);
  await expect(service.quoteAccessory({ productoId: 101, cantidad: 6, comprador: 'Gonzalo' })).rejects.toThrow('Quedan 5');
  await expect(service.quoteAccessory({ productoId: 101, cantidad: 1, comprador: 'Renato' })).rejects.toThrow('comprador seleccionado');
  const sale = await service.create({ productoId: 101, cantidad: 5, tipoCambio: 1, fechaVenta: '2026-10-25', precioVenta: 125,
    cotizacionToken: quote.cotizacionToken });
  expect(sale.precioVenta - sale.ganancia).toBe(65);
  expect(sale.distribucionStock).toEqual(quote.lotes);
  expect(lots.map((lot) => lot.stockActual)).toEqual([0, 0, 9]);
});

test.each(['stock', 'cost', 'referencia'])('rechaza una cotización cuyo %s cambió antes de consumir stock', async (change) => {
  const { service, lots, products } = quoteFixture();
  const quote = await service.quoteAccessory({ productoId: 101, cantidad: 1 });
  if (change === 'stock') lots[1].stockActual = 2;
  else if (change === 'referencia') lots.forEach(lot => { lot.referenciaId = 20; });
  else lots[0].valor.costoTotal = 24;
  await expect(service.create({ productoId: 101, cantidad: 1, tipoCambio: 1, fechaVenta: '2026-10-25', precioVenta: 25,
    cotizacionToken: quote.cotizacionToken })).rejects.toThrow('cotización cambió');
  expect(products.save).not.toHaveBeenCalled();
});

test('stock cero seguido de reposición mantiene el grupo de referencia en cotización y resumen histórico', async () => {
  const { service, lots } = quoteFixture();
  lots.forEach((lot) => { lot.referenciaId = 20; });
  const quote = await service.quoteAccessory({ productoId: 101, cantidad: 5 });
  await service.create({ productoId: 101, cantidad: 5, tipoCambio: 1, fechaVenta: '2026-10-25', precioVenta: 125, cotizacionToken: quote.cotizacionToken });
  lots.push({ ...lots[0], id: 104, stockInicial: 4, stockActual: 4, valor: { costoTotal: 80, fechaCompra: '2026-10-26' } });
  const replenished = await service.quoteAccessory({ productoId: 101, cantidad: 2 });
  expect(replenished.lotes).toEqual([{ productoId: 104, cantidad: 2, costoUnitario: 20 }]);
  const summary = await service.getAccessorySalesSummary(101);
  expect(summary).toMatchObject({ codigoInventario: 101, unidadesCompradas: 9, unidadesDisponibles: 4, unidadesVendidas: 5 });
  expect(lots[2].stockActual).toBe(9);
});

test('la cotización usa precio de otro lote y aplica mayorista desde el umbral de la referencia', async () => {
  const { service, lots, inventory } = quoteFixture();
  inventory.find.mockResolvedValue([{ productoId: 102, primerPrecioSoles: 25, ultimoPrecioSoles: 18, updatedAt: '2026-10-20' }]);
  expect(await service.quoteAccessory({ productoId: 101, cantidad: 1 })).toMatchObject({ precioPublicado: 25, precioMinimo: 18 });
  lots[0].referencia = { precioPublicadoSoles: 30, precioMinimoSoles: 20, precioMayoristaSoles: 22, cantidadMinimaMayorista: 3 };
  expect(await service.quoteAccessory({ productoId: 101, cantidad: 2 })).toMatchObject({ precioUnitarioSugerido: 30 });
  expect(await service.quoteAccessory({ productoId: 101, cantidad: 3 })).toMatchObject({ precioUnitarioSugerido: 22, total: 66, precioMayorista: 22, cantidadMinimaMayorista: 3 });
});

test('100 ventas recientes ajenas no ocultan un comparable antiguo; filtro anterior al límite y grupos separados', async () => {
  const reference: any = { id: 1, referenciaId: 20, tipo: 'accesorios', estado: 'nuevo', detalle: { modelo: 'Cable 60W' } };
  const products: any[] = [reference, ...Array.from({ length: 100 }, (_, i) => ({ id: i + 2, tipo: 'accesorios', detalle: { modelo: 'Apple Pencil' } }))];
  const sales = products.map((product) => ({ id: product.id, cantidad: 1, precioVenta: 25, fechaVenta: product.id === 1 ? '2020-01-01' : '2026-10-25', producto: product }));
  const builder: any = {};
  for (const method of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'take']) builder[method] = jest.fn(() => builder);
  builder.getMany = jest.fn(async () => sales);
  const service = new VentaService({ createQueryBuilder: () => builder } as any, {} as any,
    { findOne: async () => reference, find: async () => products } as any, {} as any, {} as any);
  const result = await service.findSimilarSold(1, 8);
  expect(result.coincidenciaExacta.map((sale) => sale.id)).toEqual([1]);
  expect(builder.andWhere).toHaveBeenCalledWith('p.id IN (:...candidateIds)', { candidateIds: [1] });
  expect(builder.take).not.toHaveBeenCalled();
});

test('comparables incluyen soloInventario y separan variante exacta, familia y devoluciones sin mutar ventas', async () => {
  const reference: any = { id: 101, tipo: 'accesorios', estado: 'nuevo', soloInventario: true, detalle: { modelo: 'Cargador 20W' } };
  const make = (id, patch = {}) => ({ id, fechaVenta: '2026-10-20', cantidad: 5, precioVenta: 100, producto: reference, ...patch });
  const rows: any[] = [make(1, { cantidadDevuelta: 2, precioDevuelto: 40 }), make(2, { estadoComercial: 'cancelada' }),
    make(3, { cantidadDevuelta: 5 }), make(4, { producto: { ...reference, detalle: { modelo: 'Cargador 30W' } } }),
    make(5, { producto: { ...reference, estado: 'usado' } })];
  const builder: any = {};
  for (const method of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'take']) builder[method] = jest.fn(() => builder);
  builder.getMany = jest.fn(async () => rows);
  const service = new VentaService({ createQueryBuilder: () => builder } as any, {} as any,
    { findOne: async () => reference, find: async () => rows.map((row) => row.producto) } as any, {} as any, {} as any);
  const result = await service.findSimilarSold(101);
  expect(result.coincidenciaExacta).toEqual([expect.objectContaining({ id: 1, cantidad: 3, total: 60, precioUnitario: 20 })]);
  expect(result.mismaFamilia.map((row) => row.id)).toEqual([4, 5]);
  expect(rows[0].cantidad).toBe(5);
  expect(builder.andWhere).not.toHaveBeenCalledWith('p.soloInventario = false');
});

test('un commit de venta invalida la lista compartida entre modulos', async () => {
  const cache: any = { del: jest.fn() };
  const dataSource: any = { subscribers: [] };
  const key = appCacheKey(cache, 'productos:list:all');
  const subscriber = registerCacheInvalidation(dataSource, cache);
  await subscriber.afterTransactionCommit!({} as any);
  expect(cache.del).toHaveBeenCalledWith(key);
  expect(appCacheKey(cache, 'productos:list:all')).not.toBe(key);
});

describe('VentaService.create', () => {
  it('usa el costo unitario fijo del lote con la compra más antigua', async () => {
    const locked = {
      id: 40,
      tipo: 'accesorios',
      codigoInventario: 12,
      stockInicial: 3,
      stockActual: 3,
      vendedor: 'Gonzalo',
      valor: { valorProducto: 90, costoEnvio: 10, costoTotal: 100, fechaCompra: '2026-07-01' },
      tracking: [{ fechaRecogido: '2026-06-15' }],
    };
    const firstLot = { id: 12, tipo: 'accesorios', vendedor: 'Gonzalo', codigoInventario: 12, stockInicial: 5, stockActual: 5, valor: { valorProducto: 100, costoEnvio: 20, costoTotal: 120, fechaCompra: '2026-05-01' }, tracking: [{ fechaRecogido: '2026-07-10' }] };
    const otherOwnerLot = { ...firstLot, id: 13, vendedor: 'Renato', valor: { ...firstLot.valor, fechaCompra: '2026-01-01' } };
    const lots = [
      firstLot,
      locked,
      otherOwnerLot,
    ];
    const transactionProductRepo = {
      find: jest.fn(async () => lots),
      save: jest.fn(async (value) => value),
      createQueryBuilder: jest.fn(() => {
        const builder: any = {
          where: jest.fn(() => builder),
          select: jest.fn(() => builder),
          orderBy: jest.fn(() => builder),
          setLock: jest.fn(() => builder),
          getOne: jest.fn(async () => locked),
          getRawMany: jest.fn(async () => [{ id: 12 }, { id: 40 }]),
        };
        return builder;
      }),
    };
    const transactionVentaRepo = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ id: 81, ...value })),
    };
    const manager = {
      getRepository: jest.fn((entity) => entity === Producto
        ? transactionProductRepo
        : transactionVentaRepo),
    };
    const productoRepo = {
      findOne: jest.fn(async () => locked),
      manager: { transaction: jest.fn(async (callback) => callback(manager)) },
    };
    const ventaRepo = { findOne: jest.fn(async () => null) };
    const cache = { del: jest.fn(async () => undefined) };
    const service = withTransactionMocks(new VentaService(
      ventaRepo as any,
      {} as any,
      productoRepo as any,
      {} as any,
      cache as any,
    ));

    const result = await service.create({
      productoId: 40,
      tipoCambio: 4,
      fechaVenta: '2026-08-13',
      precioVenta: 300,
      cantidad: 2,
      vendedor: 'Gonzalo',
    });

    expect(result).toEqual(expect.objectContaining({
      productoId: 40,
      cantidad: 2,
      ganancia: 252,
      porcentajeGanancia: 525,
      distribucionStock: [{ productoId: 12, cantidad: 2, costoUnitario: 24 }],
    }));
    expect(firstLot.stockActual).toBe(3);
    expect(locked.stockActual).toBe(3);
    expect(otherOwnerLot.stockActual).toBe(5);
    expect(transactionProductRepo.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: expect.anything() },
    }));

    const selected = await service.create({
      productoId: 40,
      loteInicialId: 40,
      tipoCambio: 4,
      fechaVenta: '2026-08-14',
      precioVenta: 300,
      cantidad: 2,
      vendedor: 'Gonzalo',
    });
    expect(selected.distribucionStock).toEqual([{ productoId: 40, cantidad: 2, costoUnitario: 100 / 3 }]);
    expect(selected.ganancia).toBe(233.33);
    expect(locked.stockActual).toBe(1);
    await expect(service.create({
      productoId: 40, tipoCambio: 1, fechaVenta: '2026-10-19', precioVenta: 100,
      cantidad: 1, vendedor: 'Renato',
    })).rejects.toThrow('corresponde al comprador');
    await expect(service.create({
      productoId: 40, tipoCambio: 1, fechaVenta: '2026-10-19', precioVenta: 100,
      cantidad: 5, vendedor: 'Gonzalo',
    })).rejects.toThrow('Stock insuficiente');
    expect(otherOwnerLot.stockActual).toBe(5);
  });

  it('registra el ingreso de Gonzalo desde el backend sin sesión de Gastos', async () => {
    const existing = {
      id: 93,
      productoId: 44,
      vendedor: 'Gonzalo',
      fechaVenta: '2026-08-04',
      precioVenta: 3000,
    };
    const ventaRepo = { findOne: jest.fn(async () => existing) };
    const gastoRepo = {
      find: jest.fn(async () => []),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 1200, ...data })),
      remove: jest.fn(),
    };
    const userRepo = {
      findOne: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 1, username: 'Admin', role: 'admin' }),
    };
    const service = withTransactionMocks(new VentaService(
      ventaRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      gastoRepo as any,
      userRepo as any,
    ));

    const result = await service.create({
      productoId: 44,
      tipoCambio: 3.75,
      fechaVenta: '2026-08-04',
      precioVenta: 3000,
      incomeBank: 'bcp',
      incomePaymentType: 'debt',
      incomeSku: 'MS-44',
    });

    expect(result).toBe(existing);
    expect(gastoRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      userId: 1,
      concepto: 'ingreso',
      monto: '3000.00',
      fecha: '2026-08-04',
      tarjeta: 'bcp',
      notas: '__SALE_INCOME__:44:93',
      saleId: 93,
      saleSku: 'MS-44',
      salePaymentType: 'debt',
      saleReceivedAmount: '0.00',
      cantidad500: 0,
    }));
  });

  it('divide una venta entre efectivo, pago directo, tarjeta y x500', async () => {
    const sale = { id: 94, productoId: 45, vendedor: 'Gonzalo', fechaVenta: '2026-10-07', precioVenta: 1000 };
    const rows: any[] = [];
    const gastoRepo = {
      find: jest.fn(async () => [...rows]),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => {
        const saved = { id: data.id || rows.length + 1, ...data };
        rows.push(saved);
        return saved;
      }),
      remove: jest.fn(),
    };
    const service = withTransactionMocks(new VentaService(
      { findOne: jest.fn(async () => sale) } as any,
      {} as any,
      { findOne: jest.fn(async () => ({ tipo: 'celular' })) } as any,
      {} as any,
      {} as any,
      gastoRepo as any,
      { findOne: jest.fn(async () => ({ id: 1, username: 'Gonzalo' })) } as any,
    ));

    await service.create({
      productoId: 45, tipoCambio: 3.7, fechaVenta: '2026-10-07', precioVenta: 1000,
      incomeBank: 'bcp', incomeSku: 'MS-45',
      incomeParts: [
        { type: 'direct', amount: 200 }, { type: 'card', amount: 300 },
        { type: 'debt', amount: 400 }, { type: 'cash', amount: 100 },
      ],
    });

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => [row.salePaymentType, row.monto, row.saleReceivedAmount, row.tarjeta])).toEqual([
      ['direct', '200.00', '200.00', 'bcp'],
      ['card', '300.00', '0.00', 'bcp'],
      ['debt', '400.00', '0.00', 'bcp'],
      ['cash', '100.00', '0.00', 'efectivo'],
    ]);
  });

  it('devuelve la venta existente sin crear otra para el mismo producto', async () => {
    const existing = { id: 91, productoId: 42, precioVenta: 1500 };
    const ventaRepo = {
      findOne: jest.fn(async () => existing),
      create: jest.fn(),
      save: jest.fn(),
    };
    const productoRepo = { findOne: jest.fn() };
    const service = withTransactionMocks(new VentaService(
      ventaRepo as any,
      {} as any,
      productoRepo as any,
      {} as any,
      {} as any,
    ));

    const result = await service.create({
      productoId: 42,
      tipoCambio: 3.75,
      fechaVenta: '2026-07-20',
      precioVenta: 1500,
    });

    expect(result).toBe(existing);
    expect(productoRepo.findOne).not.toHaveBeenCalled();
    expect(ventaRepo.save).not.toHaveBeenCalled();
  });

  it('recupera la venta ganadora si dos solicitudes se guardan a la vez', async () => {
    const winner = { id: 92, productoId: 43, precioVenta: 1600 };
    const ventaRepo = {
      findOne: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner),
      create: jest.fn((data) => data),
      save: jest.fn(async () => {
        const error: any = new Error('duplicate key');
        error.code = '23505';
        throw error;
      }),
    };
    const valor = { valorProducto: 300, costoEnvio: 50 };
    const service = withTransactionMocks(new VentaService(
      ventaRepo as any,
      {} as any,
      { findOne: jest.fn(async () => ({ id: 43, vendedor: 'Gonzalo', valor })) } as any,
      { save: jest.fn(async (data) => data) } as any,
      { del: jest.fn(async () => undefined) } as any,
    ));

    const result = await service.create({
      productoId: 43,
      tipoCambio: 3.75,
      fechaVenta: '2026-07-20',
      precioVenta: 1600,
    });

    expect(result).toBe(winner);
    expect(ventaRepo.save).toHaveBeenCalledTimes(1);
    expect(ventaRepo.findOne).toHaveBeenCalledTimes(2);
  });
});

describe('VentaService ingreso en Gastos de accesorios', () => {
  const build = (producto: any) => {
    const incomes: any[] = [];
    const gastoRepo = {
      find: jest.fn(async () => []),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => { const saved = { id: incomes.length + 1, ...data }; incomes.push(saved); return saved; }),
      remove: jest.fn(),
    };
    const service = new VentaService(
      {} as any, { findOne: jest.fn(async () => null) } as any, { findOne: jest.fn(async () => producto) } as any,
      {} as any, { del: jest.fn() } as any, gastoRepo as any,
      { findOne: jest.fn(async () => ({ id: 1, username: 'Gonzalo' })) } as any,
    );
    return { service: service as any, incomes };
  };
  const venta = { id: 70, productoId: 505, vendedor: 'Gonzalo', fechaVenta: '2026-10-25', precioVenta: 260, ganancia: 44.18, costoPendiente: false };

  it('un accesorio Apple registrado como producto ingresa el total cobrado', async () => {
    const { service, incomes } = build({ id: 505, tipo: 'accesorios', soloInventario: false });
    await service.syncSaleIncomeRows(venta, 'bcp', 'direct');
    expect(incomes.map((row) => row.monto)).toEqual(['260.00']);
  });

  it('un accesorio simple ingresa solo la ganancia y reparte las partes del cobro', async () => {
    const { service, incomes } = build({ id: 505, tipo: 'accesorios', soloInventario: true });
    await service.syncSaleIncomeRows(venta, 'bcp', undefined, undefined, [{ type: 'direct', amount: 200 }, { type: 'cash', amount: 60 }]);
    expect(incomes.map((row) => [row.salePaymentType, row.monto])).toEqual([['direct', '33.98'], ['cash', '10.20']]);
    expect(incomes.reduce((sum, row) => sum + Number(row.monto), 0)).toBeCloseTo(44.18, 2);
  });
});

describe('VentaService.completeAdelanto', () => {
  it('registra cada adelanto en su fecha y al completar solo ingresa el saldo', async () => {
    const product = { id: 20, tipo: 'iphone', vendedor: 'Gonzalo', codigoInventario: 77, valor: { valorProducto: 100, costoEnvio: 0 } };
    let advance: any = null;
    const incomes: any[] = [];
    const gastoRepo = {
      find: jest.fn(async ({ where }) => typeof where.notas === 'string'
        ? incomes.filter((row) => row.notas === where.notas)
        : incomes.filter((row) => String(row.notas).startsWith('__SALE_INCOME__:'))),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => {
        const saved = { id: data.id || incomes.length + 1, ...data };
        const index = incomes.findIndex((row) => row.id === saved.id);
        if (index >= 0) incomes[index] = saved; else incomes.push(saved);
        return saved;
      }),
      remove: jest.fn(),
    };
    const adelantoRepo = {
      findOne: jest.fn(async ({ where }) => where.productoId ? null : where.ventaId ? (advance?.ventaId === where.ventaId ? advance : null) : advance),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => { advance = { id: 5, ...data }; return advance; }),
    };
    const service = withTransactionMocks(new VentaService(
      { findOne: jest.fn(async () => null), create: jest.fn((data) => data), save: jest.fn(async (data) => ({ id: 9, ...data })) } as any,
      adelantoRepo as any,
      { findOne: jest.fn(async () => product) } as any,
      { save: jest.fn(async (data) => data) } as any,
      { del: jest.fn(async () => undefined) } as any,
      gastoRepo as any,
      { findOne: jest.fn(async () => ({ id: 1, username: 'Gonzalo' })) } as any,
    ));

    await service.createAdelanto({ productoId: 20, montoAdelanto: 500, fechaAdelanto: '2026-09-01', montoVenta: 2000, incomeBank: 'bcp' });
    withTransactionMocks(service);
    await service.addAdelantoCuota(5, { montoCuota: 300, fechaCuota: '2026-09-03', incomeBank: 'interbank' });
    expect(incomes.filter((row) => row.notas.startsWith('__SALE_ADVANCE__:')).map((row) => [row.fecha, row.monto, row.tarjeta])).toEqual([
      ['2026-09-01', '500.00', 'bcp'], ['2026-09-03', '300.00', 'interbank'],
    ]);
    await service.completeAdelanto(5, { fechaVenta: '2026-09-05', tipoCambio: 3.7, incomeBank: 'bbva' });
    expect(incomes.find((row) => row.notas === '__SALE_INCOME__:20:9')).toMatchObject({ monto: '1200.00', fecha: '2026-09-05', tarjeta: 'bbva' });
    expect(incomes.reduce((sum, row) => sum + Number(row.monto), 0)).toBe(2000);
  });
  it('calcula el porcentaje sobre el costo total aunque el adelanto sea mayor que el costo', async () => {
    const adelanto = {
      id: 8,
      productoId: 325,
      montoAdelanto: 1746.66,
      montoVenta: 1989.99,
      completadoAt: null,
    };
    const valor = {
      valorProducto: 457,
      costoEnvio: 61.68,
      costoEnvioProrrateado: 61.68,
    };
    const producto = {
      id: 325,
      vendedor: 'Gonzalo (Jorge)',
      valor,
    };

    const ventaRepo = {
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 254, ...data })),
    };
    const adelantoRepo = {
      findOne: jest.fn(async () => adelanto),
      save: jest.fn(async (data) => data),
    };
    const productoRepo = {
      findOne: jest.fn(async () => producto),
    };
    const valorRepo = {
      save: jest.fn(async (data) => data),
    };
    const cache = {
      del: jest.fn(async () => undefined),
    };
    const service = withTransactionMocks(new VentaService(
      ventaRepo as any,
      adelantoRepo as any,
      productoRepo as any,
      valorRepo as any,
      cache as any,
    ));

    withTransactionMocks(service);
    const saved = await service.completeAdelanto(8, {
      fechaVenta: '2026-07-01',
      tipoCambio: 3.5,
    });

    expect(saved).toMatchObject({
      productoId: 325,
      precioVenta: 1989.99,
      ganancia: 328.81,
      porcentajeGanancia: 19.794,
      vendedor: 'Gonzalo (Jorge)',
    });
    expect(valorRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        valorSoles: 1599.5,
        costoTotal: 1661.18,
      }),
    );
    expect(adelantoRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        ventaId: 254,
        completadoAt: expect.any(Date),
      }),
    );
  });

  it('devuelve los últimos vendidos con el mismo producto, procesador y pantalla', async () => {
    const candidates = [
      {
        id: 10,
        fechaVenta: '2026-07-01',
        precioVenta: 5990,
        producto: {
          id: 201,
          tipo: 'macbook',
          estado: 'usado',
          detalle: { gama: 'Pro', procesador: 'M3 Pro', tamano: '14"', ram: '18 GB', almacenamiento: '512 GB' },
          tracking: [{ fechaRecogido: '2026-06-20' }],
        },
      },
      {
        id: 11,
        precioVenta: 6500,
        producto: {
          id: 202,
          tipo: 'macbook',
          estado: 'usado',
          detalle: { gama: 'Pro', procesador: 'M3 Pro', tamano: '16"', ram: '18 GB', almacenamiento: '512 GB' },
        },
      },
      {
        id: 12,
        precioVenta: 5200,
        producto: {
          id: 203,
          tipo: 'macbook',
          estado: 'nuevo',
          detalle: { gama: 'Air', procesador: 'M3 Pro', tamano: '14"', ram: '16 GB', almacenamiento: '256 GB' },
        },
      },
    ];
    const queryBuilder: any = {
      leftJoinAndSelect: jest.fn(() => queryBuilder),
      where: jest.fn(() => queryBuilder),
      andWhere: jest.fn(() => queryBuilder),
      orderBy: jest.fn(() => queryBuilder),
      addOrderBy: jest.fn(() => queryBuilder),
      take: jest.fn(() => queryBuilder),
      getMany: jest.fn(async () => candidates),
    };
    const ventaRepo = { createQueryBuilder: jest.fn(() => queryBuilder) };
    const productoRepo = {
      findOne: jest.fn(async () => ({
        id: 100,
        tipo: 'macbook',
        detalle: { gama: 'Pro', procesador: 'M3 Pro', tamano: '14' },
      })),
    };
    const service = withTransactionMocks(new VentaService(
      ventaRepo as any,
      {} as any,
      productoRepo as any,
      {} as any,
      {} as any,
    ));

    const result = await service.findSimilarSold(100, 8);

    expect(result.map((sale) => sale.id)).toEqual([10]);
    expect(result[0]).toMatchObject({
      fechaVenta: '2026-07-01',
      fechaIngresoAlmacen: '2026-06-20',
      diasHastaVenta: 11,
      precioVenta: 5990,
      producto: {
        estado: 'usado',
        detalle: { ram: '18 GB', almacenamiento: '512 GB' },
      },
    });
  });

  it('identifica Apple Watch por línea, serie, tamaño y conexión', async () => {
    const candidates = [
      {
        id: 20,
        fechaVenta: '2026-07-01',
        producto: {
          tipo: 'watch',
          detalle: { gama: 'Ultra', generacion: '2', tamano: '49 mm', conexion: 'GPS + Cel' },
          tracking: [],
        },
      },
      {
        id: 21,
        fechaVenta: '2026-06-20',
        producto: {
          tipo: 'watch',
          detalle: { gama: 'Ultra', generacion: '2', tamano: '49 mm', conexion: 'GPS' },
          tracking: [],
        },
      },
    ];
    const queryBuilder: any = {
      leftJoinAndSelect: jest.fn(() => queryBuilder),
      where: jest.fn(() => queryBuilder),
      andWhere: jest.fn(() => queryBuilder),
      orderBy: jest.fn(() => queryBuilder),
      addOrderBy: jest.fn(() => queryBuilder),
      take: jest.fn(() => queryBuilder),
      getMany: jest.fn(async () => candidates),
    };
    const service = withTransactionMocks(new VentaService(
      { createQueryBuilder: jest.fn(() => queryBuilder) } as any,
      {} as any,
      {
        findOne: jest.fn(async () => ({
          id: 100,
          tipo: 'watch',
          detalle: { gama: 'Ultra', generacion: '2', tamano: '49 mm', conexion: 'GPS + Cel' },
        })),
      } as any,
      {} as any,
      {} as any,
    ));

    const result = await service.findSimilarSold(100, 8);

    expect(result.map((sale) => sale.id)).toEqual([20]);
  });

  it('no mezcla familias de accesorios en los ultimos vendidos similares', async () => {
    const candidates = [
      { id: 30, fechaVenta: '2026-08-14', producto: { tipo: 'accesorios', detalle: { modelo: 'Apple Pencil USB-C' }, tracking: [] } },
      { id: 31, fechaVenta: '2026-08-13', producto: { tipo: 'accesorios', detalle: { modelo: 'AirTag - Apple AirTag (1st Generation)' }, tracking: [] } },
      { id: 32, fechaVenta: '2026-08-12', producto: { tipo: 'accesorios', detalle: { modelo: 'AirTag - 2nd Generation' }, tracking: [] } },
    ];
    const queryBuilder: any = {
      leftJoinAndSelect: jest.fn(() => queryBuilder),
      where: jest.fn(() => queryBuilder),
      andWhere: jest.fn(() => queryBuilder),
      orderBy: jest.fn(() => queryBuilder),
      addOrderBy: jest.fn(() => queryBuilder),
      take: jest.fn(() => queryBuilder),
      getMany: jest.fn(async () => candidates),
    };
    const service = withTransactionMocks(new VentaService(
      { createQueryBuilder: jest.fn(() => queryBuilder) } as any,
      {} as any,
      { findOne: jest.fn(async () => ({ id: 399, tipo: 'accesorios', detalle: { modelo: 'AirTag - Apple AirTag (2nd Generation)' } })), find: jest.fn(async () => candidates.map((sale) => ({ ...sale.producto, id: sale.id }))) } as any,
      {} as any,
      {} as any,
    ));

    const result = await service.findSimilarSold(399, 8);

    expect(result.coincidenciaExacta).toEqual([]);
    expect(result.mismaFamilia.map((sale) => sale.id)).toEqual([31, 32]);
    expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('p.soloInventario = false');
    expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('v.productoId <> :productoId', expect.anything());
  });
});
