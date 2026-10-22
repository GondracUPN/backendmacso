// Regresiones de auditoría: las ocho expectativas exigen las reglas corregidas.
// No se usa ninguna conexión de base de datos.
import 'reflect-metadata';
import { validate } from 'class-validator';
import { CreateVentaDto } from './dto/create-venta.dto';
import { VentaService } from './venta.service';
import { ScheduledCharge } from '../schedules/scheduled-charge.entity';
import { SchedulesService } from '../schedules/schedules.service';
import { FinanzasService } from '../finanzas/finanzas.service';

// Simulador serial y con rollback para las pruebas unitarias; las mismas
// invariantes se ejecutan además contra PostgreSQL en la suite de integración.
function transacciones(service: any, state: any[]) {
  let tail = Promise.resolve();
  const manager: any = { query: async () => [] };
  manager.transaction = (run: any) => {
    const task = tail.then(async () => {
      const snapshots = structuredClone(state);
      service.transactionManager = manager;
      try { return await run(manager); }
      catch (e) {
        state.forEach((value, i) => Array.isArray(value) ? value.splice(0, value.length, ...snapshots[i]) : Object.assign(value, snapshots[i]));
        throw e;
      } finally { service.transactionManager = undefined; }
    });
    tail = task.catch(() => undefined); return task;
  };
  service.adelantoRepo.manager = manager;
  jest.spyOn(service, 'conManager').mockImplementation(() => service);
}

function equipo() {
  const producto = { id: 7, tipo: 'macbook', vendedor: 'Gonzalo',
    valor: { valorProducto: 1000, monedaCompra: 'PEN', costoEnvio: 0, costoTotal: 1000 } };
  const ventas: any[] = [];
  const ventaRepo = { findOne: jest.fn(async () => ventas[0] || null), create: (v: any) => v,
    save: jest.fn(async (v: any) => { const saved = { id: 90, ...v }; ventas.push(saved); return saved; }) };
  const service = new VentaService(ventaRepo as any, {} as any,
    { findOne: async () => producto } as any, { save: async (v: any) => v } as any,
    { del: async () => undefined } as any);
  transacciones(service, [ventas, producto]);
  return { service, ventas, ventaRepo };
}
const dto = { productoId: 7, tipoCambio: 3.7, fechaVenta: '2026-10-20', precioVenta: 1500, vendedor: 'Gonzalo' };

test('AUDIT corregido: el DTO de venta rechaza precio y tipo de cambio negativos', async () => {
  const errors = await validate(Object.assign(new CreateVentaDto(), dto, { tipoCambio: -3, precioVenta: -80 }));
  expect(errors.map((e) => e.property).sort()).toEqual(['precioVenta', 'tipoCambio']);
});

test('AUDIT corregido: compra PEN 1000 y venta 1500 produce ganancia 500', async () => {
  const { service } = equipo();
  const venta = await service.create(dto);
  expect(venta.ganancia).toBe(500);
});

test('AUDIT corregido: si falla el ingreso, revierte la venta', async () => {
  const { service, ventas } = equipo();
  jest.spyOn(service as any, 'syncSaleIncome').mockRejectedValue(new Error('ingreso no disponible'));
  await expect(service.create(dto)).rejects.toThrow('ingreso no disponible');
  expect(ventas).toHaveLength(0);
});

test('AUDIT corregido: dos solicitudes simultáneas del mismo equipo devuelven una venta', async () => {
  const { service, ventas } = equipo();
  await Promise.all([service.create(dto), service.create(dto)]);
  expect(ventas).toHaveLength(1);
});

test('AUDIT corregido: un borrado fallido revierte la reposición de stock', async () => {
  const producto = { id: 7, tipo: 'accesorios', stockInicial: 2, stockActual: 0 };
  const repo = { findOne: async () => ({ id: 90, producto, cantidad: 1 }),
    remove: async () => { throw new Error('fallo de borrado'); } };
  const service = new VentaService(repo as any, {} as any,
    { save: async (p: any) => p } as any, {} as any, {} as any);
  transacciones(service, [producto]);
  await expect(service.remove(90, 'Error de digitación')).rejects.toThrow('fallo de borrado');
  expect(producto.stockActual).toBe(0);
});

test('AUDIT corregido: recurrente del día 31 genera todos los meses con su banco', async () => {
  const sc = { id: 1, userId: 1, active: true, nextDate: '2026-01-31', tipo: 'recurrente',
    concepto: 'comida', moneda: 'PEN', monto: '10', metodoPago: 'debito', tarjeta: 'bcp' };
  const gastos: any[] = [];
  const repo: any = { find: async () => [sc], save: async (v: any) => v };
  const gastoRepo: any = { findOne: async () => null, create: (v: any) => v, save: async (v: any) => { gastos.push(v); return v; } };
  const manager: any = { query: async () => [], getRepository: (entity: any) => entity === ScheduledCharge ? repo : gastoRepo };
  repo.manager = { transaction: async (run: any) => run(manager) };
  const service = new SchedulesService(repo, gastoRepo);
  await service.processDue(1, '2026-03-31');
  await service.processDue(1, '2026-03-31');
  expect(sc.nextDate).toBe('2026-04-30');
  expect(gastos.map(g => g.fecha)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  expect(gastos.every(g => g.tarjeta === 'bcp' && g.tarjetaPago === null)).toBe(true);
});

function rapida() {
  const ventas: any[] = [];
  const repo = { find: async () => ventas.filter(v => v.operacionKey),
    update: async (id: number, changes: any) => Object.assign(ventas.find(v => v.id === id), changes),
    findOne: async ({ where }: any) => ventas.find(v => v.id === where.id) };
  const ds = { getRepository: () => repo, query: async () => [], transaction: async (run: any) => {
    const before = structuredClone(ventas);
    try { return await run(ds); } catch (e) { ventas.splice(0, ventas.length, ...before); throw e; }
  }, createQueryRunner: () => ({
    connect: async () => {}, query: async () => {}, release: async () => {} }) };
  const create = jest.fn(async (v: any) => { const saved = { id: ventas.length + 1, ...v }; ventas.push(saved); return saved; });
  const service = new FinanzasService(ds as any, {} as any, { conManager: () => ({ create }) } as any);
  jest.spyOn(service as any, 'cuentaParaCobro').mockResolvedValue({ id: 99, codigo: 'billetera_nueva', tipo: 'billetera', activo: true });
  return { ventas, service, create };
}
const dtoRapida: any = { idempotencyKey: 'auditoria-20261020', fecha: '2026-10-20',
  tipoCambio: 3.7, vendedor: 'Gonzalo', metodo: 'yape', estadoCobro: 'pagado', cuentaReceptoraId: 99,
  items: [{ productoId: 7, cantidad: 1, precioUnitario: 80 }] };

test('AUDIT corregido: venta rápida conserva la cuenta nueva y el método Yape', async () => {
  const { service, create } = rapida();
  await service.ventaRapida(dtoRapida);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ incomeAccountId: 99, incomeMethod: 'yape', incomeParts: [{ type: 'direct', amount: 80 }] }));
  expect(create.mock.calls[0][0].incomeBank).toBeUndefined();
});

test('AUDIT corregido: fallo en segundo artículo revierte todo el carrito y permite reintentar', async () => {
  const { service, create, ventas } = rapida();
  create.mockImplementationOnce(async (v: any) => { const sale = { id: 1, ...v }; ventas.push(sale); return sale; });
  create.mockRejectedValueOnce(new Error('Stock insuficiente'));
  const dto = { ...dtoRapida, items: [...dtoRapida.items, { productoId: 8, cantidad: 1, precioUnitario: 40 }] };
  await expect(service.ventaRapida(dto)).rejects.toThrow('Stock insuficiente');
  expect(ventas).toHaveLength(0);
  await expect(service.ventaRapida(dto)).resolves.toMatchObject({ repetida: false });
  expect(ventas).toHaveLength(2);
});
