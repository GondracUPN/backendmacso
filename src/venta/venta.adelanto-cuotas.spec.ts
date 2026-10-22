import { VentaService } from './venta.service';
import { Venta } from './venta.entity';
import { VentaAdelanto } from './venta-adelanto.entity';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { User } from '../auth/entities/user.entity';

// Repositorio en memoria que entiende los operadores de TypeORM usados por el servicio.
const matches = (row: any, where: any) => Object.entries(where).every(([key, expected]: [string, any]) => {
  const value = row[key] ?? null;
  if (expected && typeof expected === 'object' && '_type' in expected) {
    if (expected._type === 'isNull') return value == null;
    if (expected._type === 'in') return expected._value.includes(value);
    if (expected._type === 'like') return String(value ?? '').startsWith(String(expected._value).replace(/%$/, ''));
  }
  return String(value) === String(expected);
});

const setup = (product: any = { id: 279, tipo: 'iphone', vendedor: 'Gonzalo', valor: { valorProducto: 520, costoEnvio: 0 } }) => {
  let advance: any = null;
  let sale: any = null;
  const incomes: any[] = [];
  let nextId = 1;
  const gastoRepo = {
    find: jest.fn(async ({ where }) => incomes.filter((row) => (Array.isArray(where) ? where : [where]).some((item) => matches(row, item)))),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => {
      if (!data.id) data.id = nextId++;
      if (!incomes.includes(data)) incomes.push(data);
      return data;
    }),
    remove: jest.fn(async (rows) => (Array.isArray(rows) ? rows : [rows]).forEach((row) => incomes.splice(incomes.indexOf(row), 1))),
  };
  const adelantoRepo = {
    findOne: jest.fn(async ({ where }) => {
      if (where.productoId) return null;
      if (where.ventaId) return advance?.ventaId === where.ventaId ? advance : null;
      return advance?.id === where.id ? advance : null;
    }),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => { advance = Object.assign(advance || { id: 10 }, data); return advance; }),
  };
  const ventaRepo = {
    findOne: jest.fn(async ({ where }) => (where.id && sale?.id === where.id ? sale : null)),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => { sale = { id: 405, ...data }; return sale; }),
  };
  const service = new VentaService(
    ventaRepo as any,
    adelantoRepo as any,
    { findOne: jest.fn(async () => product) } as any,
    { save: jest.fn(async (data) => data) } as any,
    { del: jest.fn(async () => undefined) } as any,
    gastoRepo as any,
    { findOne: jest.fn(async () => ({ id: 1, username: 'Gonzalo' })) } as any,
  );
  const internal = service as any;
  const repos = new Map<any, any>([[Venta, ventaRepo], [VentaAdelanto, adelantoRepo], [Producto, internal.productoRepo],
    [ProductoValor, internal.valorRepo], [Gasto, gastoRepo], [User, internal.userRepo]]);
  const manager: any = { query: jest.fn(async () => []), getRepository: (entity: any) => repos.get(entity), transaction: async (run: any) => {
    const before = JSON.parse(JSON.stringify({ advance, sale, incomes, product }));
    try { return await run(manager); } catch (error) {
      advance = before.advance; sale = before.sale; incomes.splice(0, incomes.length, ...before.incomes);
      Object.assign(product, before.product);
      throw error;
    }
  } };
  (adelantoRepo as any).manager = manager;
  const advanceRows = () => incomes.filter((row) => String(row.notas).startsWith('__SALE_ADVANCE__:'))
    .sort((a, b) => String(a.notas).localeCompare(String(b.notas)))
    .map((row) => [row.notas, row.fecha, row.monto, row.tarjeta]);
  const saleRows = () => incomes.filter((row) => String(row.notas).startsWith('__SALE_INCOME__:'));
  return { service, incomes, gastoRepo, manager, getSale: () => sale, advanceRows, saleRows, getAdvance: () => advance, setAdvance: (value: any) => { advance = value; } };
};

describe('Adelantos con varias cuotas', () => {
  it('resume reservas abiertas, pagadas, vendidas y pagos originados en Finanzas', async () => {
    const { service, setAdvance } = setup();
    setAdvance({ id: 10, productoId: 279, montoVenta: 2600, montoAdelanto: 600, fechaAdelanto: '2026-07-10', cuotas: [{ fecha: '2026-07-10', monto: 600, pagoId: 99 }] });
    expect(await service.resumenAdelanto(10)).toMatchObject({ precio: 2600, cobrado: 600, falta: 2000, estado: 'reservado', pagos: [expect.objectContaining({ origen: 'finanzas', editable: false })] });
    await service.addAdelantoCuota(10, { montoCuota: 2000, fechaCuota: '2026-09-10', incomeBank: 'bcp' });
    expect(await service.resumenAdelanto(10)).toMatchObject({ estado: 'pagado', cobrado: 2600, falta: 0 });
    await service.completeAdelanto(10, { fechaVenta: '2026-09-11', tipoCambio: 3.5 });
    expect(await service.resumenAdelanto(10)).toMatchObject({ estado: 'vendido', ventaId: 405, cobrado: 2600, falta: 0 });
  });

  it('registra el último pago y cierra sin un ingreso de saldo cero', async () => {
    const { service, saleRows, incomes, getAdvance } = setup();
    await service.createAdelanto({ productoId: 279, montoAdelanto: 600, montoVenta: 2600, fechaAdelanto: '2026-07-10' });
    await service.addAdelantoCuota(10, { montoCuota: 2000, fechaCuota: '2026-09-11', cerrarVenta: { fechaVenta: '2026-09-11', tipoCambio: 3.5 } });
    expect(getAdvance().ventaId).toBe(405);
    expect(saleRows()).toEqual([]);
    expect(incomes.reduce((sum, row) => sum + Number(row.monto), 0)).toBe(2600);
  });

  it('rechaza cerrar si falta dinero sin guardar la cuota', async () => {
    const { service, getAdvance } = setup();
    await service.createAdelanto({ productoId: 279, montoAdelanto: 600, montoVenta: 2600, fechaAdelanto: '2026-07-10' });
    await expect(service.addAdelantoCuota(10, { montoCuota: 100, fechaCuota: '2026-09-11', cerrarVenta: { fechaVenta: '2026-09-11', tipoCambio: 3.5 } })).rejects.toThrow('Falta S/ 1900.00');
    expect(getAdvance().montoAdelanto).toBe(600);
  });

  it('revierte la venta, el cierre y el costo si falla la sincronización del ledger', async () => {
    const { service, incomes, getSale, getAdvance, manager } = setup();
    await service.createAdelanto({ productoId: 279, montoAdelanto: 600, montoVenta: 2600, fechaAdelanto: '2026-07-10' });
    const ledger = { sincronizarAdelanto: jest.fn(async () => undefined), sincronizarIngresosVenta: jest.fn(async () => { throw new Error('fallo de sincronización'); }) };
    (service as any).ledger = ledger;
    await expect(service.completeAdelanto(10, { fechaVenta: '2026-09-11', tipoCambio: 3.5 })).rejects.toThrow('fallo de sincronización');
    expect(getSale()).toBeNull();
    expect(getAdvance().completadoAt).toBeUndefined();
    expect(getAdvance().ventaId).toBeUndefined();
    expect(incomes).toHaveLength(1);
    expect((await (service as any).productoRepo.findOne({ where: { id: 279 } })).valor.costoTotal).toBeUndefined();
    expect(ledger.sincronizarIngresosVenta).toHaveBeenCalledWith(405, manager, expect.any(Object));
  });

  it('revierte también el último pago si no se puede cerrar la venta', async () => {
    const { service, getAdvance, getSale, incomes } = setup();
    await service.createAdelanto({ productoId: 279, montoAdelanto: 600, montoVenta: 2600, fechaAdelanto: '2026-07-10' });
    (service as any).ledger = { sincronizarAdelanto: async () => undefined, sincronizarIngresosVenta: async () => { throw new Error('fallo de cierre'); } };
    await expect(service.addAdelantoCuota(10, { montoCuota: 2000, fechaCuota: '2026-09-11', cerrarVenta: { fechaVenta: '2026-09-11', tipoCambio: 3.5 } })).rejects.toThrow('fallo de cierre');
    expect(getAdvance().montoAdelanto).toBe(600);
    expect(getAdvance().cuotas).toHaveLength(1);
    expect(getSale()).toBeNull();
    expect(incomes).toHaveLength(1);
  });

  it('incluye el cobro de cierre y bloquea los pagos cancelados', async () => {
    const { service, getAdvance } = setup();
    await service.createAdelanto({ productoId: 279, montoAdelanto: 600, montoVenta: 2600, fechaAdelanto: '2026-07-10' });
    await service.completeAdelanto(10, { fechaVenta: '2026-09-11', tipoCambio: 3.5, incomeBank: 'bbva' });
    expect(await service.resumenAdelanto(10)).toMatchObject({ cobrado: 2600, falta: 0, estado: 'vendido', pagos: [expect.objectContaining({ origen: 'reserva' }), expect.objectContaining({ origen: 'cierre', monto: 2000, editable: true, banco: 'bbva' })] });
    getAdvance().canceladoAt = new Date();
    expect((await service.resumenAdelanto(10)).pagos.every((payment) => !payment.editable)).toBe(true);
  });

  const reservar = async (service: VentaService) => {
    await service.createAdelanto({ productoId: 279, montoAdelanto: 700, fechaAdelanto: '2026-06-27', montoVenta: 2600, incomeBank: 'bcp' });
    await service.addAdelantoCuota(10, { montoCuota: 600, fechaCuota: '2026-07-10', incomeBank: 'bcp' });
    await service.addAdelantoCuota(10, { montoCuota: 650, fechaCuota: '2026-08-10', incomeBank: 'bcp' });
  };

  it('al completar registra el saldo aunque los ingresos del adelanto ya estén ligados a la venta', async () => {
    const { service, incomes, advanceRows, saleRows } = setup();
    await reservar(service);
    await service.completeAdelanto(10, { fechaVenta: '2026-09-11', tipoCambio: 3.5, incomeBank: 'bcp', incomePaymentType: 'direct' });

    expect(advanceRows()).toEqual([
      ['__SALE_ADVANCE__:10:0', '2026-06-27', '700.00', 'bcp'],
      ['__SALE_ADVANCE__:10:1', '2026-07-10', '600.00', 'bcp'],
      ['__SALE_ADVANCE__:10:2', '2026-08-10', '650.00', 'bcp'],
    ]);
    expect(saleRows()).toEqual([expect.objectContaining({
      notas: '__SALE_INCOME__:279:405', monto: '650.00', fecha: '2026-09-11', salePaymentType: 'direct', saleReceivedAmount: '650.00',
    })]);
    expect(incomes.reduce((sum, row) => sum + Number(row.monto), 0)).toBe(2600);

    // Reintentar una venta ya completada no duplica nada.
    await service.completeAdelanto(10, { fechaVenta: '2026-09-11', tipoCambio: 3.5, incomeBank: 'bcp', incomePaymentType: 'direct' });
    expect(incomes).toHaveLength(4);
    await expect(service.getSalePayments(405)).resolves.toMatchObject({ advanceAmount: 1950, parts: [{ type: 'direct', amount: 650 }] });
  });

  it('edita y elimina cuotas de una venta completada ajustando el saldo cobrado', async () => {
    const { service, incomes, advanceRows, saleRows, getAdvance } = setup();
    await reservar(service);
    await service.completeAdelanto(10, { fechaVenta: '2026-09-11', tipoCambio: 3.5, incomeBank: 'bcp', incomePaymentType: 'direct' });

    await service.updateAdelantoCuota(10, 1, { montoCuota: 500, fechaCuota: '2026-07-11', incomeBank: 'bbva', incomePaymentType: 'direct' });
    expect(advanceRows()[1]).toEqual(['__SALE_ADVANCE__:10:1', '2026-07-11', '500.00', 'bbva']);
    expect(getAdvance().montoAdelanto).toBe(1850);
    expect(saleRows().map((row) => row.monto)).toEqual(['750.00']);

    await service.deleteAdelantoCuota(10, 0);
    expect(advanceRows()).toEqual([
      ['__SALE_ADVANCE__:10:0', '2026-07-11', '500.00', 'bbva'],
      ['__SALE_ADVANCE__:10:1', '2026-08-10', '650.00', 'bcp'],
    ]);
    expect(saleRows().map((row) => row.monto)).toEqual(['1450.00']);
    expect(incomes.reduce((sum, row) => sum + Number(row.monto), 0)).toBe(2600);

    await expect(service.updateAdelantoCuota(10, 0, { montoCuota: 2500, fechaCuota: '2026-07-11' }))
      .rejects.toThrow('no pueden superar');
  });

  it('agrega otro pago a una venta cerrada descontándolo del cobro al cerrar', async () => {
    const { service, incomes, advanceRows, saleRows, getAdvance } = setup();
    await reservar(service);
    await service.completeAdelanto(10, { fechaVenta: '2026-09-11', tipoCambio: 3.5, incomeBank: 'bcp', incomePaymentType: 'direct' });

    await service.addAdelantoCuota(10, { montoCuota: 400, fechaCuota: '2026-09-01', incomeBank: 'interbank', incomePaymentType: 'direct' });
    expect(advanceRows()[3]).toEqual(['__SALE_ADVANCE__:10:3', '2026-09-01', '400.00', 'interbank']);
    expect(getAdvance().montoAdelanto).toBe(2350);
    expect(saleRows().map((row) => row.monto)).toEqual(['250.00']);
    expect(incomes.reduce((sum, row) => sum + Number(row.monto), 0)).toBe(2600);

    await expect(service.addAdelantoCuota(10, { montoCuota: 300, fechaCuota: '2026-09-02' })).rejects.toThrow('no pueden superar');
    expect(getAdvance().cuotas).toHaveLength(4);
  });

  it('vincula el ingreso manual de una cuota antigua en lugar de duplicarlo al editarla', async () => {
    const { service, incomes, setAdvance } = setup();
    setAdvance({ id: 10, productoId: 279, montoAdelanto: 600, montoVenta: 2600, fechaAdelanto: '2026-07-10', cuotas: [{ fecha: '2026-07-10', monto: 600 }] });
    incomes.push({ id: 1265, userId: 1, concepto: 'ingreso', metodoPago: 'debito', moneda: 'PEN', monto: '600.00', fecha: '2026-07-10', tarjeta: 'bcp', notas: null, saleId: null });

    await service.updateAdelantoCuota(10, 0, { montoCuota: 600, fechaCuota: '2026-07-12', incomeBank: 'bcp', incomePaymentType: 'direct' });
    expect(incomes).toEqual([expect.objectContaining({ id: 1265, notas: '__SALE_ADVANCE__:10:0', fecha: '2026-07-12', monto: '600.00' })]);
  });
});
