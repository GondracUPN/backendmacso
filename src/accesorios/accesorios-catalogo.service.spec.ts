import { AccesoriosCatalogoService } from './accesorios-catalogo.service';
import { AccesorioCatalogo } from './accesorio-catalogo.entity';

function fixture() {
  const states: any[] = [];
  const row: any = { referenciaId: 5, referencia: { activo: true, fotoUrl: 'https://img.test/cable.jpg' }, comprador: 'Gonzalo',
    nombre: 'Cable USB-C', disponible: 6, precioPublicado: 25, estado: 'nuevo', compatibilidad: 'iPhone', codigos: [10, 11],
    producto: { id: 10 }, lotes: [{ id: 10, valor: { costoTotal: 99 } }, { id: 11, valor: { costoTotal: 200 } }] };
  const repo = { find: async () => states, findOneBy: async ({ key }) => states.find((s) => s.key === key),
    create: (s) => ({ seleccionado: false, ...s }), save: async (s) => {
      const index = states.findIndex((v) => v.key === s.key);
      if (index < 0) states.push(s); else states[index] = s;
      return s;
    } };
  const em = { query: async () => [], getRepository: (entity) => entity === AccesorioCatalogo ? repo : { find: async () => [] } };
  const ds: any = { ...em, transaction: (fn) => fn(em) };
  const operativo = jest.fn(async () => [row]);
  const service = new AccesoriosCatalogoService(ds, { operativo } as any);
  return { states, row, service, operativo, ds };
}
describe('selección comercial de accesorios', () => {
  const originalFetch = global.fetch, originalUrl = process.env.CATALOG_SYNC_URL;
  beforeEach(() => {
    process.env.CATALOG_SYNC_URL = 'https://catalog.test/api/sync/product';
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ accessorySnapshot: true }) })) as any;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl == null) delete process.env.CATALOG_SYNC_URL; else process.env.CATALOG_SYNC_URL = originalUrl;
  });
  test('persiste selección y envía todo el stock libre con el costo unitario para el administrador', async () => {
    const { service, states, row, ds, operativo } = fixture();
    row.disponible = 17;
    row.costoProximaUnidad = 9.5;
    const [entry] = await service.list();
    await service.synchronize();
    // Solo retiro preventivo de las importaciones antiguas; nunca un alta.
    expect(JSON.parse((fetch as jest.Mock).mock.calls[0][1].body).product.selected).toBe(false);
    expect(states[0].seleccionado).toBe(false);
    (fetch as jest.Mock).mockClear();
    await service.select([entry.key, entry.key], true);
    expect(states).toHaveLength(1);
    const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({ event: 'accessory.snapshot', product: { stock: 17, price: '25', costoCompraUnitario: 9.5, selected: true } });
    expect(body.product.images).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/costoTotal|margen|proveedor|precioMinimo|valor/);
    await service.select([entry.key], true); expect(fetch).toHaveBeenCalledTimes(1);
    const reloaded = new AccesoriosCatalogoService(ds, { operativo } as any);
    expect((await reloaded.list())[0]).toMatchObject({ seleccionado: true, enviado: true });
    row.disponible = 0; row.precioPublicado = 30;
    await service.synchronize();
    expect(JSON.parse((fetch as jest.Mock).mock.calls[1][1].body).product).toMatchObject({ stock: 0, price: '30', selected: true });
    await service.select([entry.key], false);
    expect(JSON.parse((fetch as jest.Mock).mock.calls[2][1].body).product).toMatchObject({ stock: 0, selected: false });
    expect(row.lotes).toHaveLength(2);
  });
  test('actualiza al reservar una unidad y permite reenviar el mismo stock seleccionado', async () => {
    const { service, row } = fixture();
    row.disponible = 17;
    const [entry] = await service.list();
    await service.select([entry.key], true);
    row.disponible = 16;
    await service.synchronize();
    await service.synchronize(true);
    expect((fetch as jest.Mock).mock.calls.map(([, options]) => JSON.parse(options.body).product.stock)).toEqual([17, 16, 16]);
    expect((await service.list())[0].stockEnviado).toBe(16);
  });
  test('sincroniza al completar o quitar modelos de un accesorio enviado, sin cambiar su stock', async () => {
    const { service, row } = fixture();
    row.lotes = [{ id: 10, detalle: { modelosCompatibles: [' iPad Pro 11″ (M4) ', 'iPad Pro 13″ (M4)'] } }];
    const [entry] = await service.list();
    await service.select([entry.key], true);
    row.lotes[0].detalle.modelosCompatibles = ['iPad Pro 11″ (M4)'];
    await service.synchronize();
    row.lotes[0].detalle.modelosCompatibles = [];
    await service.synchronize();
    await service.synchronize();

    const snapshots = (fetch as jest.Mock).mock.calls.map(([, options]) => JSON.parse(options.body).product);
    expect(snapshots.map((product) => product.modelosCompatibles)).toEqual([
      ['iPad Pro 11″ (M4)', 'iPad Pro 13″ (M4)'], ['iPad Pro 11″ (M4)'], [],
    ]);
    expect(snapshots.every((product) => product.stock === 6 && product.selected)).toBe(true);
  });
  test('conserva la descripción de la referencia y anuncia modelos compartidos para lotes fusionados', async () => {
    const { service, row } = fixture();
    const referencia = 'iPad Air 4.ª / 5.ª gen. · iPad Pro 11″';
    row.referencia.compatibilidad = referencia;
    row.producto.fusionAccesorioId = 10;
    row.lotes[0].detalle = { modelosCompatibles: [referencia] };
    const [entry] = await service.list();
    await service.select([entry.key], true);
    row.lotes[0].detalle.modelosCompatibles = ['iPad Pro 11″ (M4)', 'iPad Pro 13″ (M4)'];
    row.lotes[1].detalle = { modelosCompatibles: ['iPad Pro 13″ (M4)', 'iPad Pro 11″ (M5)'] };
    await service.synchronize();
    const snapshots = (fetch as jest.Mock).mock.calls.map(([, options]) => JSON.parse(options.body).product);
    expect(snapshots.map((product) => product.modelosCompatibles)).toEqual([[referencia], ['iPad Pro 13″ (M4)']]);
  });
  test('envía juntos un accesorio fusionado y otro lote con el stock propio de cada uno', async () => {
    const { service, row, operativo } = fixture();
    operativo.mockResolvedValue([
      { ...row, disponible: 16, producto: { id: 10, fusionAccesorioId: 10 } },
      { ...row, nombre: 'Cargador', disponible: 7, producto: { id: 12, empaqueAccesorio: 'con_caja' }, lotes: [{ id: 12 }] },
    ]);
    const entries = await service.list();
    const sent = await service.select(entries.map((entry) => entry.key), true);

    expect((fetch as jest.Mock).mock.calls.map(([, options]) => {
      const { sku, stock } = JSON.parse(options.body).product;
      return { sku, stock };
    })).toEqual([{ sku: 'acc-lot-10', stock: 16 }, { sku: 'acc-lot-12', stock: 7 }]);
    expect(sent.map((entry) => entry.stockEnviado)).toEqual([16, 7]);
  });
  test('rechaza datos incompletos y reintenta fallos conservando selección', async () => {
    const { service, row, states } = fixture();
    const [entry] = await service.list();
    row.precioPublicado = null;
    await expect(service.select([entry.key], true)).rejects.toThrow('precio publicado');
    expect(states).toHaveLength(0);
    row.precioPublicado = 25;
    (fetch as jest.Mock).mockRejectedValueOnce(new Error('Sin conexión'));
    await service.select([entry.key], true);
    expect(states[0]).toMatchObject({ seleccionado: true, error: 'Sin conexión' });
    await service.synchronize();
    expect(states[0].error).toBeNull(); expect(states[0].syncHash).toBeTruthy();
  });
  test('rechaza el envío sin stock antes de guardar o contactar al catálogo', async () => {
    const { service, row, states } = fixture();
    const [entry] = await service.list();
    row.disponible = 0;
    await expect(service.select([entry.key], true)).rejects.toThrow('sin stock disponible');
    expect(states).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('un envío fallido no se da de alta sin stock al reintentar y se recupera al reponer', async () => {
    const { service, row, states } = fixture();
    const [entry] = await service.list();
    (fetch as jest.Mock).mockRejectedValueOnce(new Error('Sin conexión'));
    await service.select([entry.key], true);
    row.disponible = 0;
    await service.synchronize();
    expect(states[0].payload).toMatchObject({ selected: false, stock: 0 });
    expect(states[0].error).toMatch(/Sin stock/);
    expect((await service.list())[0].enviado).toBe(false);
    row.disponible = 2;
    await service.synchronize();
    expect(states[0].payload).toMatchObject({ selected: true, stock: 2 });
    expect(states[0].error).toBeNull();
  });
  test('retira grupos archivados y recupera una ficha corregida sin perder la selección', async () => {
    const { service, row, operativo, states } = fixture();
    const [entry] = await service.list(); await service.select([entry.key], true);
    row.referencia.activo = false; await service.synchronize();
    expect(states[0].payload.selected).toBe(false); expect(states[0].seleccionado).toBe(true);
    row.referencia.activo = true; await service.synchronize(); expect(states[0].payload.selected).toBe(true);
    row.referencia.fotoUrl = 'foto-invalida'; await service.synchronize();
    expect(states[0].payload.selected).toBe(true);
    expect(states[0].payload.images).toBeUndefined();
    operativo.mockResolvedValue([]); await service.synchronize(); expect(states[0].payload.selected).toBe(false);
  });
  test('separa compradores y soporta accesorios heredados sin crear referencias', async () => {
    const { service, row, operativo } = fixture();
    operativo.mockResolvedValue([row, { ...row, comprador: 'Renato' }, { ...row, referenciaId: null }]);
    const entries = await service.list();
    expect(new Set(entries.map((e) => e.key)).size).toBe(3);
    expect(entries[2].key).toBe('lot-10');
  });
  test('las importaciones antiguas se retiran incluso sin catalogoEnviado, hasta una selección explícita', async () => {
    const { service, row, states } = fixture();
    await service.synchronize();
    expect(states).toHaveLength(1);
    const product = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body).product;
    expect(product).toMatchObject({ legacySkus: ['MS-10', 'MS-11'], selected: false, stock: 0 });
  });
  test('el retiro desde el inventario del catálogo queda como no enviado y no vuelve a enviarse', async () => {
    const { service, states, row } = fixture();
    const [entry] = await service.list();
    await service.select([entry.key], true);
    const sku = states[0].payload.sku;
    await service.withdrawFromCatalog(sku);
    await service.withdrawFromCatalog(sku); // reintento idempotente
    expect((await service.list())[0]).toMatchObject({ seleccionado: false, enviado: false });
    expect(row.disponible).toBe(6); // No borra ni descuenta inventario de Servicios.
    (fetch as jest.Mock).mockClear();
    await service.synchronize();
    for (const call of (fetch as jest.Mock).mock.calls) expect(JSON.parse(call[1].body).product.selected).toBe(false);
    await expect(service.withdrawFromCatalog('MS-99')).rejects.toThrow('SKU');
  });
});
