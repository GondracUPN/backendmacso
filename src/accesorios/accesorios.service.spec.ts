import { AccesoriosService } from './accesorios.service';
import { AccesorioReferencia } from './accesorio-referencia.entity';
import { AccesorioIngreso } from './accesorio-ingreso.entity';
import { Producto } from '../producto/producto.entity';
import { Inventario } from '../inventario/inventario.entity';
import { allocateAccessory, resolveAccessoryPrices } from '../venta/accessory-quote';

const referenceData = { categoria: ' Cable ', marca: ' Apple ', modelo: 'USB-C', generacion: '', variante: ' 60W  1M ', estado: 'nuevo', originalidad: 'original' };
function fixture() {
  const refs: any[] = [], receipts: any[] = [], lots: any[] = [];
  const repo = (rows: any[]) => ({ create: (value) => ({ activo: true, ...value }),
    findOne: jest.fn(async ({ where }) => rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null),
    findOneBy: jest.fn(async (where) => rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null),
    save: jest.fn(async (value) => { if (!value.id) { value.id = rows.length + 1; rows.push(value); } else Object.assign(rows.find((row) => row.id === value.id) || {}, value); return value; }) });
  const refRepo = repo(refs), receiptRepo = repo(receipts);
  const productRepo = { find: jest.fn(async () => lots), count: jest.fn(async () => lots.length), update: jest.fn(async () => ({})) };
  const inventoryRepo = { update: jest.fn(async () => ({})), find: jest.fn(async () => []) };
  const manager: any = { query: jest.fn(async () => []), getRepository: (entity) => entity === AccesorioReferencia ? refRepo : entity === AccesorioIngreso ? receiptRepo : entity === Producto ? productRepo : inventoryRepo };
  const create = jest.fn(async (data) => { const lot = { id: lots.length + 10, ...data, stockInicial: data.cantidad, stockActual: data.cantidad,
    referencia: refs.find((row) => row.id === data.referenciaId), valor: { ...data.valor, costoTotal: data.valor.valorProducto * (data.valor.monedaCompra === 'USD' ? data.valor.tipoCambioCompra : 1) } }; lots.push(lot); return lot; });
  const recalcEnvioGrupo = jest.fn(async () => {});
  const products: any = { conManager: () => ({ create, recalcEnvioGrupo }) };
  const ds: any = { transaction: (run) => run(manager), getRepository: manager.getRepository };
  const service = new AccesoriosService(ds, products, { findSimilarSold: async () => ({ coincidenciaExacta: [] }) } as any);
  return { service, refs, receipts, lots, create, recalcEnvioGrupo, refRepo, inventoryRepo, productRepo };
}

test('normaliza una referencia y responde 409 con su id ante duplicados; desactiva sin borrar', async () => {
  const { service, refs } = fixture();
  const reference = await service.createReference(referenceData);
  expect(reference).toMatchObject({ categoria: 'cable', marca: 'apple', variante: '60w 1m' });
  try { await service.createReference({ ...referenceData, modelo: 'usb-c' }); throw new Error('No rechazó duplicado'); }
  catch (error) { expect(error.getResponse()).toMatchObject({ id: reference.id }); }
  await service.deactivateReference(reference.id);
  expect(refs).toHaveLength(1);
  expect(refs[0].activo).toBe(false);
});

test('ingreso idempotente conserva respuesta, crea un lote por línea y transmite el cambio USD', async () => {
  const { service, create, lots } = fixture();
  const reference = await service.createReference(referenceData);
  const dto: any = { idempotencyKey: 'compra-prueba-1', referenciaId: reference.id, comprador: 'Renato', fechaCompra: '2026-10-25',
    tipo: 'local', moneda: 'USD', tipoCambioCompra: 4.1, lineas: [{ cantidad: 2, costoUnitario: 10 }, { cantidad: 3, costoUnitario: 15 }] };
  const first = await service.ingreso(dto);
  lots[0].stockActual = 0;
  expect(await service.ingreso(dto)).toEqual(first);
  expect(create).toHaveBeenCalledTimes(2);
  await expect(service.updateReference(reference.id, { modelo: 'Otra variante' })).rejects.toThrow('ya tiene lotes');
  expect(first.costoTotalSoles).toBe(266.5);
  expect(create.mock.calls[0][0]).toMatchObject({ referenciaId: reference.id, vendedor: 'Renato', valor: { tipoCambioCompra: 4.1 } });
  await expect(service.ingreso({ ...dto, comprador: 'Gonzalo' })).rejects.toThrow('otros datos');
  await expect(service.ingreso({ ...dto, tipoCambioCompra: undefined })).rejects.toThrow('tipo de cambio');
});

test('importadas prorratean solo el grupo nuevo y quedan fuera del stock vendible hasta su recojo', async () => {
  const { service, recalcEnvioGrupo, productRepo, inventoryRepo } = fixture();
  const reference = await service.createReference(referenceData);
  await service.ingreso({ idempotencyKey: 'importada-prueba', referenciaId: reference.id, comprador: 'Gonzalo', fechaCompra: '2026-10-25',
    tipo: 'importada', moneda: 'PEN', costoLogistica: 20, lineas: [{ cantidad: 2, costoUnitario: 10 }] });
  expect(recalcEnvioGrupo).toHaveBeenCalledWith(expect.stringMatching(/^acc-/), 20);
  expect(productRepo.update).toHaveBeenCalledWith(10, { origen: 'accesorio_importado' });
  expect(inventoryRepo.update).toHaveBeenCalledWith({ productoId: 10 }, { enAlmacen: false });
  const lot: any = { id: 10, referenciaId: reference.id, tipo: 'accesorios', origen: 'accesorio_importado', vendedor: 'Gonzalo', stockActual: 2, stockInicial: 2, valor: { costoTotal: 20 }, tracking: [{ estado: 'comprado_sin_tracking' }] };
  expect(() => allocateAccessory([lot], lot, 1)).toThrow('Stock insuficiente');
  lot.tracking[0].estado = 'recogido';
  expect(allocateAccessory([lot], lot, 1).costoTotal).toBe(10);
});

test('referencia y comprador definen el grupo; los lotes antiguos conservan código y comprador', () => {
  const base: any = { id: 1, tipo: 'accesorios', vendedor: 'Gonzalo', codigoInventario: 7, stockInicial: 1, stockActual: 1, valor: { costoTotal: 10 } };
  const linked = { ...base, referenciaId: 20 };
  const lots = [linked, { ...linked, id: 2, codigoInventario: 99 }, { ...linked, id: 3, vendedor: 'Renato' }, { ...base, id: 4 }];
  expect(allocateAccessory(lots, linked, 2).lotes.map((lot) => lot.productoId)).toEqual([1, 2]);
  expect(allocateAccessory(lots, base, 1).lotes.map((lot) => lot.productoId)).toEqual([4]);
  expect(() => allocateAccessory(lots, base, 2)).toThrow('Quedan 1');
});

test('prioridad de precios: referencia, ficha propia y ficha más reciente con valor no nulo', () => {
  const fichas = [{ productoId: 1, updatedAt: '2026-01-01', primerPrecioSoles: null, ultimoPrecioSoles: 18 },
    { productoId: 2, updatedAt: '2026-02-01', primerPrecioSoles: 25, ultimoPrecioSoles: 19 },
    { productoId: 3, updatedAt: '2026-03-01', primerPrecioSoles: null, ultimoPrecioSoles: null }];
  expect(resolveAccessoryPrices({ id: 1 }, fichas)).toMatchObject({ precioPublicado: 25, precioMinimo: 18 });
  expect(resolveAccessoryPrices({ id: 1, referencia: { precioPublicadoSoles: 30, precioMinimoSoles: 22 } as any }, fichas)).toMatchObject({ precioPublicado: 30, precioMinimo: 22 });
});


test.each([1, 15])('operativo mantiene tres consultas para %s grupos y convierte la venta neta', async (count) => {
 const lots=Array.from({length:count},(_,i)=>({id:i+1,tipo:'accesorios',referenciaId:i+1,codigoInventario:100+i,vendedor:'Gonzalo',stockActual:2,stockInicial:2,valor:{costoTotal:20}}));
 const productFind=jest.fn(async()=>lots),inventoryFind=jest.fn(async()=>[]);
 const query=jest.fn(async(_sql: string)=>[{grupo:'ref:1',cantidad:'1',total:'30',precioUnitario:'30',fechaVenta:'2026-10-25'}]);
 const sold=jest.fn();const ds:any={query,getRepository:entity=>({find:entity===Producto?productFind:inventoryFind})};
 const rows=await new AccesoriosService(ds,{} as any,{findSimilarSold:sold} as any).operativo();
 expect(rows).toHaveLength(count);expect(productFind).toHaveBeenCalledTimes(1);expect(inventoryFind).toHaveBeenCalledTimes(1);expect(query).toHaveBeenCalledTimes(1);expect(sold).not.toHaveBeenCalled();
 expect(query.mock.calls[0]?.[0] || '').toContain('DISTINCT ON');expect(rows[0].ultimaVenta).toMatchObject({cantidad:1,total:30,precioUnitario:30});
});
