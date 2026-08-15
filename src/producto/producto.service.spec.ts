import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProductoService } from './producto.service';
import { Producto } from './producto.entity';
import { ProductoDetalle } from './producto-detalle.entity';
import { ProductoValor } from './producto-valor.entity';
import { Tracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';
import { PersonalEshopex } from './personal-eshopex.entity';
import { Inventario } from '../inventario/inventario.entity';

const repositoryMock = () => ({
  create: jest.fn((value) => value),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneOrFail: jest.fn(),
  delete: jest.fn(),
  update: jest.fn(),
  count: jest.fn(),
  createQueryBuilder: jest.fn(),
});

describe('ProductoService', () => {
  let service: ProductoService;
  let productoRepo: ReturnType<typeof repositoryMock>;
  let ventaRepo: ReturnType<typeof repositoryMock>;
  let inventarioRepo: ReturnType<typeof repositoryMock>;
  let detalleRepo: ReturnType<typeof repositoryMock>;
  let valorRepo: ReturnType<typeof repositoryMock>;
  let trackingRepo: ReturnType<typeof repositoryMock>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductoService,
        { provide: getRepositoryToken(Producto), useValue: repositoryMock() },
        { provide: getRepositoryToken(ProductoDetalle), useValue: repositoryMock() },
        { provide: getRepositoryToken(ProductoValor), useValue: repositoryMock() },
        { provide: getRepositoryToken(Tracking), useValue: repositoryMock() },
        { provide: getRepositoryToken(Venta), useValue: repositoryMock() },
        { provide: getRepositoryToken(PersonalEshopex), useValue: repositoryMock() },
        { provide: getRepositoryToken(Inventario), useValue: repositoryMock() },
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ProductoService>(ProductoService);
    productoRepo = module.get(getRepositoryToken(Producto));
    ventaRepo = module.get(getRepositoryToken(Venta));
    inventarioRepo = module.get(getRepositoryToken(Inventario));
    detalleRepo = module.get(getRepositoryToken(ProductoDetalle));
    valorRepo = module.get(getRepositoryToken(ProductoValor));
    trackingRepo = module.get(getRepositoryToken(Tracking));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('permite editar manualmente el costo de envío del producto', async () => {
    const producto = {
      id: 50,
      tipo: 'iphone',
      estado: 'usado',
      envioGrupoId: null,
      accesorios: [],
      detalle: {},
      valor: {
        valorProducto: 100,
        valorDec: 20,
        peso: 1,
        fechaCompra: '2026-08-01',
        valorSoles: 370,
        costoEnvio: 40,
        costoTotal: 410,
      },
      tracking: [],
    } as any;
    productoRepo.findOne.mockResolvedValue(producto);
    productoRepo.findOneOrFail.mockImplementation(async () => producto);
    productoRepo.save.mockImplementation(async (value) => value);
    valorRepo.save.mockImplementation(async (value) => value);

    await service.update(50, {
      valor: {
        valorProducto: 100,
        valorDec: 20,
        peso: 1,
        fechaCompra: '2026-08-01',
        costoEnvio: 75,
      },
    });

    expect(valorRepo.save).toHaveBeenLastCalledWith(expect.objectContaining({
      costoEnvio: 75,
      costoTotal: 445,
      costoEnvioProrrateado: 75,
      costoTotalProrrateado: 445,
    }));
  });

  it('crea accesorios en inventario con stock por unidades y tracking inicial', async () => {
    detalleRepo.save.mockImplementation(async (value) => ({ id: 10, ...value }));
    valorRepo.save.mockImplementation(async (value) => ({ id: 20, ...value }));
    productoRepo.save.mockImplementation(async (value) => ({ id: 30, ...value }));
    inventarioRepo.save.mockImplementation(async (value) => value);
    trackingRepo.save.mockImplementation(async (value) => ({ id: 40, ...value }));
    productoRepo.findOneOrFail.mockResolvedValue({
      id: 30,
      tipo: 'accesorios',
      stockInicial: 5,
      stockActual: 5,
      detalle: { gama: 'Cable', modelo: 'Cable USB-C a MagSafe 3 – 2 m' },
      tracking: [{ id: 40, estado: 'comprado_sin_tracking' }],
    });

    const result = await service.create({
      tipo: 'accesorios',
      estado: 'nuevo',
      cantidad: 5,
      detalle: { gama: 'Cable', modelo: 'Cable USB-C a MagSafe 3 – 2 m' },
      valor: { valorProducto: 100, fechaCompra: '2026-08-13' },
    } as any);

    expect(productoRepo.save).toHaveBeenCalledWith(expect.objectContaining({ stockInicial: 5, stockActual: 5 }));
    expect(inventarioRepo.save).toHaveBeenCalledWith(expect.objectContaining({ productoId: 30, enAlmacen: true }));
    expect(trackingRepo.save).toHaveBeenCalledWith(expect.objectContaining({ productoId: 30, estado: 'comprado_sin_tracking' }));
    expect(result.tracking).toEqual([expect.objectContaining({ estado: 'comprado_sin_tracking' })]);
  });

  it('crea una recompra separada con el mismo código visible mientras quede stock', async () => {
    const existing = {
      id: 12,
      tipo: 'accesorios',
      estado: 'nuevo',
      vendedor: 'Gonzalo',
      accesorios: [],
      stockInicial: 5,
      stockActual: 2,
      codigoInventario: 12,
      detalle: { gama: 'Cable', modelo: 'Cable USB-C a MagSafe 3 – 2 m' },
      valor: {
        id: 7,
        valorProducto: 100,
        valorDec: 10,
        peso: 1,
        fechaCompra: '2026-08-01',
        valorSoles: 370,
        costoEnvio: 20,
        costoTotal: 390,
      },
      tracking: [{ id: 1, estado: 'recogido' }],
    } as any;
    productoRepo.find.mockResolvedValue([existing]);
    detalleRepo.save.mockImplementation(async (value) => ({ id: 21, ...value }));
    valorRepo.save.mockImplementation(async (value) => ({ id: 22, ...value }));
    productoRepo.save.mockImplementation(async (value) => ({ id: 40, ...value }));
    inventarioRepo.save.mockImplementation(async (value) => value);
    trackingRepo.save.mockImplementation(async (value) => ({ id: 2, ...value }));
    productoRepo.findOneOrFail.mockResolvedValue({
      id: 40,
      tipo: 'accesorios',
      estado: 'nuevo',
      vendedor: 'Renato',
      stockInicial: 3,
      stockActual: 3,
      codigoInventario: 12,
      detalle: { gama: 'Cable', modelo: 'Cable USB-C a MagSafe 3 – 2 m' },
      valor: { valorProducto: 60 },
      tracking: [{ id: 2, estado: 'comprado_sin_tracking' }],
    });

    const result = await service.create({
      tipo: 'accesorios',
      estado: 'nuevo',
      vendedor: 'Renato',
      cantidad: 3,
      detalle: { gama: 'Cable', modelo: 'Cable USB-C a MagSafe 3 – 2 m' },
      valor: { valorProducto: 60, valorDec: 5, peso: 0.5, fechaCompra: '2026-08-13' },
    } as any);

    expect(result).toEqual(expect.objectContaining({ id: 40, codigoInventario: 12, stockActual: 3 }));
    expect(existing).toEqual(expect.objectContaining({ id: 12, stockInicial: 5, stockActual: 2 }));
    expect(productoRepo.save).toHaveBeenCalledWith(expect.objectContaining({ codigoInventario: 12, stockInicial: 3, stockActual: 3 }));
    expect(trackingRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      productoId: 40,
      estado: 'comprado_sin_tracking',
    }));
    expect(detalleRepo.save).toHaveBeenCalled();
  });

  it('rechaza un lote cuya distribución no coincide con la cantidad', async () => {
    await expect(
      service.createLote({
        producto: { tipo: 'iphone', estado: 'nuevo' },
        cantidad: 3,
        distribucion: [{ vendedor: 'Gonzalo', cantidad: 2 }],
      }),
    ).rejects.toThrow('La distribución debe sumar 3 productos');
  });

  it('crea un producto por cada unidad distribuida', async () => {
    const createSpy = jest
      .spyOn(service, 'create')
      .mockResolvedValueOnce({ id: 1 } as Producto)
      .mockResolvedValueOnce({ id: 2 } as Producto)
      .mockResolvedValueOnce({ id: 3 } as Producto);

    const result = await service.createLote({
      producto: {
        tipo: 'iphone',
        estado: 'nuevo',
        valor: {
          valorProducto: 100,
          valorDec: 20,
          peso: 1,
          fechaCompra: '2026-06-06',
        },
      },
      cantidad: 3,
      distribucion: [
        { vendedor: 'Gonzalo (Jorge)', cantidad: 2 },
        { vendedor: 'Renato', cantidad: 1 },
      ],
    });

    expect(result.map((producto) => producto.id)).toEqual([1, 2, 3]);
    expect(createSpy).toHaveBeenCalledTimes(3);
    expect(createSpy.mock.calls.map(([producto]) => producto.vendedor)).toEqual([
      'Gonzalo (Jorge)',
      'Gonzalo (Jorge)',
      'Renato',
    ]);
    expect(
      createSpy.mock.calls.map(([producto]) => producto.valor?.valorProducto),
    ).toEqual([33.34, 33.33, 33.33]);
    expect(
      createSpy.mock.calls.map(([producto]) => producto.valor?.valorDec),
    ).toEqual([20, 20, 20]);
    expect(
      createSpy.mock.calls.reduce(
        (sum, [producto]) => sum + Number(producto.valor?.valorProducto || 0),
        0,
      ),
    ).toBeCloseTo(100, 2);
  });

  it('vincula todo el lote en un único grupo de envío', async () => {
    const productos = [
      { id: 1, valor: { valorProducto: 50, valorDec: 20, peso: 2 } },
      { id: 2, valor: { valorProducto: 50, valorDec: 20, peso: 2 } },
    ] as Producto[];
    jest
      .spyOn(service, 'create')
      .mockResolvedValueOnce(productos[0])
      .mockResolvedValueOnce(productos[1]);
    jest
      .spyOn(service as any, 'recalcEnvioGrupo')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'syncTrackingEnGrupo')
      .mockResolvedValue(undefined);
    productoRepo.save.mockResolvedValue(productos);
    productoRepo.find.mockImplementation(async ({ where }: any) =>
      productos.map((producto) => ({
        ...producto,
        envioGrupoId: where.envioGrupoId,
      })),
    );

    const result = await service.createLote({
      producto: {
        tipo: 'iphone',
        estado: 'nuevo',
        valor: {
          valorProducto: 100,
          valorDec: 20,
          peso: 2,
          fechaCompra: '2026-06-06',
        },
      },
      cantidad: 2,
      distribucion: [{ vendedor: 'Gonzalo', cantidad: 2 }],
      vincularTodos: true,
    });

    expect(productoRepo.save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ envioGrupoId: expect.stringMatching(/^grp-/) }),
        expect.objectContaining({ envioGrupoId: expect.stringMatching(/^grp-/) }),
      ]),
    );
    expect(result[0].envioGrupoId).toBe(result[1].envioGrupoId);
  });

  it('conserva el grupo existente al vincular un lote nuevo', async () => {
    const productos = [
      { id: 11, envioGrupoId: 'grp-existente', valor: { valorProducto: 50 } },
      { id: 12, envioGrupoId: 'grp-existente', valor: { valorProducto: 50 } },
    ] as Producto[];
    jest.spyOn(service, 'create')
      .mockResolvedValueOnce(productos[0])
      .mockResolvedValueOnce(productos[1]);
    jest.spyOn(service as any, 'recalcEnvioGrupo').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'syncTrackingEnGrupo').mockResolvedValue(undefined);
    productoRepo.save.mockResolvedValue(productos);
    productoRepo.find.mockResolvedValue(productos);

    await service.createLote({
      producto: { tipo: 'watch', estado: 'usado', vincularCon: 5 } as any,
      cantidad: 2,
      distribucion: [{ vendedor: 'Gonzalo', cantidad: 2 }],
      vincularTodos: true,
    });

    expect(productoRepo.save).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ envioGrupoId: 'grp-existente' }),
      expect.objectContaining({ envioGrupoId: 'grp-existente' }),
    ]));
  });

  it('permite agregar productos a un grupo de envío sin límite fijo', async () => {
    productoRepo.findOne.mockResolvedValue({
      id: 80,
      envioGrupoId: null,
      tracking: [{ id: 1, estado: 'comprado_en_camino', casillero: 'Alex' }],
      valor: { valorProducto: 100 },
    });
    productoRepo.save.mockImplementation(async (value) => value);
    productoRepo.count.mockResolvedValue(50);

    const groupId = await (service as any).ensureEnvioGrupo(80, 'Alex', 'grp-grande');

    expect(groupId).toBe('grp-grande');
    expect(productoRepo.save).toHaveBeenCalledWith(expect.objectContaining({ envioGrupoId: 'grp-grande' }));
    expect(productoRepo.count).not.toHaveBeenCalled();
  });

  it('suma tarifa adicional cuando el peso supera 10 kg', () => {
    expect((service as any).getTarifa(10)).toBe(267.22);
    expect((service as any).getTarifa(11)).toBeCloseTo(288.26, 2);
    expect((service as any).getTarifa(11.82)).toBeCloseTo(309.3, 2);
  });

  it('mantiene tarifa antigua para compras hasta el 1 de mayo de 2026', () => {
    expect((service as any).getTarifa(10, '2026-05-01')).toBe(260);
    expect((service as any).getTarifa(11, '2026-05-01')).toBe(280);
    expect((service as any).getTarifa(10, '2026-05-02')).toBe(267.22);
  });

  it('mantiene honorarios antiguos hasta el corte y usa los nuevos despues', () => {
    expect((service as any).getHonorarios(90, '2026-05-01')).toBe(16.3);
    expect((service as any).getHonorarios(150, '2026-05-01')).toBe(25.28);
    expect((service as any).getHonorarios(90, '2026-05-02')).toBe(23.5);
    expect((service as any).getHonorarios(150, '2026-05-02')).toBe(28.8);
    expect((service as any).getHonorarios(500, '2026-05-02')).toBe(39.76);
    expect((service as any).getHonorarios(1500, '2026-05-02')).toBe(60.16);
  });

  it('lista para catalogo solo recogidos, en almacen, con fotos y no vendidos', async () => {
    ventaRepo.find.mockResolvedValue([{ productoId: 2 }]);
    productoRepo.find.mockResolvedValue([
      { id: 1, catalogoEnviado: false, tracking: [{ id: 3, estado: 'recogido' }] },
      { id: 2, catalogoEnviado: false, tracking: [{ id: 2, estado: 'recogido' }] },
      { id: 3, catalogoEnviado: false, tracking: [{ id: 1, estado: 'en_eshopex' }] },
      { id: 4, catalogoEnviado: false, tracking: [{ id: 4, estado: 'recogido' }] },
    ]);
    inventarioRepo.find.mockResolvedValue([{ productoId: 1, enAlmacen: true, fotosTomadas: true }]);

    const result = await service.findPendientesCatalogo();

    expect(productoRepo.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { catalogoEnviado: false },
    }));
    expect(inventarioRepo.find).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ enAlmacen: true, fotosTomadas: true }),
    }));
    expect(result.map((producto) => producto.id)).toEqual([1]);
  });

  it('mantiene en catálogo un accesorio con venta parcial y publica su stock restante', async () => {
    ventaRepo.find.mockResolvedValue([{ productoId: 9 }]);
    productoRepo.find.mockResolvedValue([{
      id: 9,
      tipo: 'accesorios',
      stockInicial: 10,
      stockActual: 6,
      catalogoEnviado: false,
      detalle: { gama: 'Cargador', modelo: 'Cargador 20W' },
      tracking: [],
    }]);
    inventarioRepo.find.mockResolvedValue([{ productoId: 9, enAlmacen: true, fotosTomadas: true }]);

    const result = await service.findPendientesCatalogo();
    const payload = (service as any).buildPayload(result[0]);

    expect(result.map((producto) => producto.id)).toEqual([9]);
    expect(payload).toEqual(expect.objectContaining({ title: 'Cargador 20W', stock: 6 }));
  });

  it('envía al catálogo la información comercial y de inventario', async () => {
    const originalFetch = global.fetch;
    const originalUrl = process.env.CATALOG_SYNC_URL;
    process.env.CATALOG_SYNC_URL = 'https://catalog.example/api/sync/product';
    jest.spyOn(service, 'findPendientesCatalogo').mockResolvedValue([{
      id: 42,
      tipo: 'iphone',
      estado: 'usado',
      accesorios: ['Caja'],
      detalle: { numero: '15', modelo: 'Pro', almacenamiento: '256 GB' },
      valor: { costoTotal: 800 },
      tracking: [{ id: 1, estado: 'recogido' }],
    } as any]);
    inventarioRepo.find.mockResolvedValue([{
      productoId: 42,
      color: 'Space Black',
      primerPrecioSoles: 2300,
      ultimoPrecioSoles: 2500,
      ciclosBateria: 5,
      saludBateria: 100,
      accesorios: ['Cable'],
      tieneGarantia: true,
      tipoGarantia: 'limitada',
      garantiaHasta: '2027-05-10',
    }]);
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ json: async () => ({ exists: false }) })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock as any;

    try {
      const result = await service.syncDisponiblesConCatalogo();
      const request = fetchMock.mock.calls[1][1];
      const sent = JSON.parse(request.body).product;

      expect(sent).toEqual(expect.objectContaining({
        price: '2499.99',
        saleType: 'VENTA_SIMPLE',
        minOfferPrice: null,
        color: 'Space Black',
        batteryCycles: 5,
        batteryHealth: 100,
        includes: ['Caja', 'Cable'],
        warrantyEnabled: true,
        warrantyType: 'Garantía limitada de Apple',
        warrantyDate: '2027-05-10',
      }));
      expect(result).toEqual(expect.objectContaining({ total: 1, enviados: 1, marcados: 1 }));
      expect(productoRepo.update).toHaveBeenCalledWith(
        { id: 42 },
        expect.objectContaining({ catalogoEnviado: true }),
      );
    } finally {
      global.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.CATALOG_SYNC_URL;
      else process.env.CATALOG_SYNC_URL = originalUrl;
    }
  });

  it('envia sellados con un ano de garantia y solo accesorios basicos del Apple Watch', async () => {
    const originalFetch = global.fetch;
    const originalUrl = process.env.CATALOG_SYNC_URL;
    process.env.CATALOG_SYNC_URL = 'https://catalog.example/api/sync/product';
    jest.spyOn(service, 'findPendientesCatalogo').mockResolvedValue([{
      id: 77,
      tipo: 'watch',
      estado: 'nuevo',
      accesorios: ['Caja', 'Cable fake', 'Correa fake', 'Case'],
      detalle: { gama: 'Ultra', generacion: '2', tamano: '49 mm', conexion: 'GPS + Cel' },
      valor: { costoTotal: 1800 },
      tracking: [{ id: 1, estado: 'recogido' }],
    } as any]);
    inventarioRepo.find.mockResolvedValue([{
      productoId: 77,
      color: 'Natural',
      enAlmacen: true,
      fotosTomadas: true,
      accesorios: ['Case'],
    }]);
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ json: async () => ({ exists: false }) })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock as any;

    try {
      await service.syncDisponiblesConCatalogo();
      const sent = JSON.parse(fetchMock.mock.calls[1][1].body).product;
      expect(sent).toEqual(expect.objectContaining({
        title: 'Apple Watch Ultra 2 49 mm GPS + Cel',
        warrantyDate: '1 año de garantía',
        includes: ['Caja', 'Cable fake', 'Correa fake'],
        watchType: 'Ultra',
        watchVersion: '2',
        watchConnection: 'GPS + Cellular',
        watchSize: '49',
      }));
    } finally {
      global.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.CATALOG_SYNC_URL;
      else process.env.CATALOG_SYNC_URL = originalUrl;
    }
  });
});
