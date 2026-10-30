import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProductoService, normalizeResumenYear, purchaseYearOf } from './producto.service';
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
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  findOneOrFail: jest.fn(),
  delete: jest.fn(),
  update: jest.fn(),
  count: jest.fn(),
  createQueryBuilder: jest.fn(() => {
    const qb: any = {};
    for (const method of ['leftJoin', 'select', 'where', 'andWhere', 'orderBy']) qb[method] = () => qb;
    qb.getOne = jest.fn().mockResolvedValue(null);
    return qb;
  }),
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

  it('el prorrateo de un ingreso nuevo conserva su cambio y su logística al editar después', async () => {
    const lots: any[] = [
      { id: 1, tipo: 'accesorios', stockInicial: 2, valor: { valorProducto: 20, valorSoles: 82, tipoCambioCompra: 4.1 } },
      { id: 2, tipo: 'accesorios', stockInicial: 3, valor: { valorProducto: 45, valorSoles: 184.5, tipoCambioCompra: 4.1 } },
    ];
    productoRepo.find.mockResolvedValue(lots);
    valorRepo.save.mockImplementation(async (value) => value);
    await service.recalcEnvioGrupo('acc-nueva-compra', 20);
    expect(lots.reduce((sum, lot) => sum + lot.valor.costoEnvioProrrateado, 0)).toBe(20);
    expect(lots.reduce((sum, lot) => sum + lot.valor.costoTotalProrrateado, 0)).toBeCloseTo(286.5);
    await service.recalcEnvioGrupo('acc-nueva-compra');
    expect(lots.reduce((sum, lot) => sum + lot.valor.costoTotalProrrateado, 0)).toBeCloseTo(286.5);
    expect(lots[0].valor.valorSoles).toBe(82);
    expect(lots[1].valor.tipoCambioCompra).toBe(4.1);
    expect(ventaRepo.save).not.toHaveBeenCalled();
  });

  it.each([null, { id: 77, codigoInventario: 77, stockActual: 0 }])('resuelve código de referencia sin depender del stock anterior: %s', async (previous) => {
    productoRepo.findOne.mockResolvedValue(previous);
    (productoRepo as any).manager = { query: jest.fn(async () => []), getRepository: () => ({ findOneBy: async () => ({ id: 55, activo: true }) }) };
    (service as any).referenceTransaction = true;
    detalleRepo.save.mockImplementation(async (value) => ({ id: 10, ...value }));
    valorRepo.save.mockImplementation(async (value) => ({ id: 20, ...value }));
    productoRepo.save.mockImplementation(async (value) => ({ id: 99, ...value }));
    productoRepo.findOneOrFail.mockResolvedValue({ id: 99, tipo: 'accesorios', referenciaId: 55, tracking: [] });
    await service.create({ tipo: 'accesorios', estado: 'nuevo', referenciaId: 55, soloInventario: true, cantidad: 2,
      detalle: { modelo: 'Cable' }, valor: { valorProducto: 20, valorDec: 0, peso: 0, fechaCompra: '2026-10-25', monedaCompra: 'PEN' } });
    expect(productoRepo.findOne).toHaveBeenCalledWith({ where: { referenciaId: 55 }, order: { id: 'ASC' }, loadEagerRelations: false });
    if (previous) expect(productoRepo.save).toHaveBeenCalledWith(expect.objectContaining({ codigoInventario: 77, referenciaId: 55 }));
    else expect(productoRepo.update).toHaveBeenCalledWith(99, { codigoInventario: 99 });
  });

  it('convierte una compra simple USD a 3.7 aunque se envie otro cambio', async () => {
    detalleRepo.save.mockImplementation(async (value) => ({ id: 10, ...value }));
    valorRepo.save.mockImplementation(async (value) => ({ id: 20, ...value }));
    productoRepo.save.mockImplementation(async (value) => ({ id: 31, ...value }));
    productoRepo.findOneOrFail.mockResolvedValue({ id: 31, tipo: 'accesorios', tracking: [] });
    await service.create({ tipo: 'accesorios', estado: 'nuevo', soloInventario: true, cantidad: 5,
      detalle: { modelo: 'Cable' }, valor: { valorProducto: 50, valorDec: 0, peso: 0, fechaCompra: '2026-10-25',
        monedaCompra: 'USD', tipoCambioCompra: 4.1, costoEnvio: 5 } });
    expect(valorRepo.save).toHaveBeenCalledWith(expect.objectContaining({ valorProducto: 50, valorSoles: 185, costoTotal: 190 }));
    expect(valorRepo.save.mock.calls[0][0]).toHaveProperty('tipoCambioCompra', 3.7);
    expect(ventaRepo.save).not.toHaveBeenCalled();
  });

  it.each(['USD', 'PEN'])('editar moneda de un accesorio simple a %s recalcula a 3.7 y conserva envío', async (monedaCompra) => {
    const producto: any = { id: 31, tipo: 'accesorios', soloInventario: true, estado: 'nuevo',
      detalle: { modelo: 'Cable' }, accesorios: [], valor: { id: 10, valorProducto: 20,
        valorSoles: 20, costoEnvio: 4, costoTotal: 24, monedaCompra: 'PEN', peso: 0, valorDec: 0 } };
    productoRepo.findOne.mockResolvedValue(producto);
    productoRepo.findOneOrFail.mockResolvedValue(producto);
    await service.update(31, { valor: { valorProducto: 20, monedaCompra, costoEnvio: 4 } } as any);
    expect(valorRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      monedaCompra, valorSoles: monedaCompra === 'USD' ? 74 : 20,
      costoTotalProrrateado: monedaCompra === 'USD' ? 78 : 24,
    }));
  });

  it('editar datos comerciales de un accesorio conserva costos guardados incluso con envío agrupado', async () => {
    const valor = { id: 10, valorProducto: 50, valorSoles: 205, costoEnvio: 5, costoTotal: 210,
      costoEnvioProrrateado: 3, costoTotalProrrateado: 208, monedaCompra: 'USD' };
    const producto: any = { id: 31, tipo: 'accesorios', estado: 'nuevo', envioGrupoId: 'grupo',
      detalle: { modelo: 'Cable' }, valor: { ...valor }, accesorios: [] };
    productoRepo.findOne.mockResolvedValue(producto);
    productoRepo.findOneOrFail.mockResolvedValue(producto);
    const persisted: any[] = [];
    productoRepo.save.mockImplementation(async (value) => {
      persisted.push(JSON.parse(JSON.stringify(value)));
      return value;
    });
    detalleRepo.save.mockImplementation(async (value) => value);
    await service.update(31, { detalle: { modelo: 'Cable USB-C' } });
    expect(persisted[0].valor).toEqual(valor);
    expect(valorRepo.save).not.toHaveBeenCalled();
    expect(ventaRepo.save).not.toHaveBeenCalled();
  });

  it('cachea la lista 60 segundos expresados en milisegundos', async () => {
    const cache = (service as any).cache;
    const qb: any = {};
    for (const method of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy']) qb[method] = () => qb;
    qb.getMany = jest.fn().mockResolvedValue([]);
    productoRepo.createQueryBuilder.mockReturnValue(qb);
    await service.findAll();
    expect(cache.set).toHaveBeenCalledWith(expect.stringContaining('productos:list:all'), [], 60_000);
    jest.spyOn(service, 'stats').mockResolvedValue({} as any);
    await service.statsCached();
    expect(cache.set).toHaveBeenLastCalledWith(expect.stringContaining('productos:stats'), expect.any(Object), 300_000);
  });

  it('una lista fria usa una consulta y una lista caliente no consulta la base', async () => {
    const memory = new Map();
    const cache = (service as any).cache;
    cache.get.mockImplementation(async (key) => memory.get(key));
    cache.set.mockImplementation(async (key, value) => { memory.set(key, value); });
    const qb: any = {};
    for (const method of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy']) qb[method] = () => qb;
    qb.getMany = jest.fn().mockResolvedValue([]);
    productoRepo.createQueryBuilder.mockReturnValue(qb);
    await service.findAll();
    expect(qb.getMany).toHaveBeenCalledTimes(1);
    qb.getMany.mockClear();
    await service.findAll();
    expect(qb.getMany).not.toHaveBeenCalled();
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

  it('crea accesorios simples solo para Inventario y sin tracking', async () => {
    detalleRepo.save.mockImplementation(async (value) => ({ id: 10, ...value }));
    valorRepo.save.mockImplementation(async (value) => ({ id: 20, ...value }));
    productoRepo.save.mockImplementation(async (value) => ({ id: 31, ...value }));
    inventarioRepo.save.mockImplementation(async (value) => value);
    productoRepo.findOneOrFail.mockResolvedValue({
      id: 31, tipo: 'accesorios', soloInventario: true, tracking: [],
    });

    const result = await service.create({
      tipo: 'accesorios', estado: 'nuevo', soloInventario: true, cantidad: 4,
      detalle: { modelo: 'Cable USB-C' },
      valor: { valorProducto: 60, valorDec: 0, peso: 0, fechaCompra: '2026-10-02' },
    } as any);

    expect(productoRepo.save).toHaveBeenCalledWith(expect.objectContaining({ soloInventario: true, stockActual: 4 }));
    expect(inventarioRepo.save).toHaveBeenCalledWith(expect.objectContaining({ productoId: 31, enAlmacen: true }));
    expect(trackingRepo.save).not.toHaveBeenCalled();
    expect(result.tracking).toEqual([]);
  });

  it('excluye las compras exclusivas de Inventario del listado de Productos', async () => {
    const query = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    productoRepo.createQueryBuilder.mockReturnValue(query);

    await service.findAll();

    expect(query.where).toHaveBeenCalledWith('p.soloInventario = false');
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
    const matching: any = {};
    for (const method of ['leftJoin', 'select', 'where', 'andWhere', 'orderBy']) matching[method] = () => matching;
    matching.getOne = jest.fn().mockResolvedValue({ id: 12, codigoInventario: 12 });
    productoRepo.createQueryBuilder.mockReturnValue(matching);
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
    expect(valorRepo.save).toHaveBeenCalledTimes(1);
    expect(valorRepo.update).toHaveBeenCalledWith(22, expect.objectContaining({
      costoEnvioProrrateado: expect.any(Number), costoTotalProrrateado: expect.any(Number),
    }));
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
      where: { catalogoEnviado: false, soloInventario: false },
    }));
    expect(inventarioRepo.find).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ enAlmacen: true, fotosTomadas: true }),
    }));
    expect(result.map((producto) => producto.id)).toEqual([1]);
  });

  it('excluye los accesorios simples de pendientes del catalogo incluso al recalcular', async () => {
    ventaRepo.find.mockResolvedValue([]);
    productoRepo.find.mockResolvedValue([
      { id: 10, tipo: 'accesorios', soloInventario: true, stockActual: 3, tracking: [] },
      { id: 11, tipo: 'accesorios', soloInventario: false, stockActual: 2, tracking: [] },
    ]);
    inventarioRepo.find.mockResolvedValue([
      { productoId: 10, enAlmacen: true, fotosTomadas: true },
      { productoId: 11, enAlmacen: true, fotosTomadas: true },
    ]);

    const result = await service.findPendientesCatalogo(true);

    expect(productoRepo.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { soloInventario: false },
    }));
    expect(result.map((producto) => producto.id)).toEqual([11]);
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
  it('limita el resumen a los productos comprados en el año pedido', async () => {
    const reservedQuery: any = { select: () => reservedQuery, where: () => reservedQuery, getRawMany: async () => [] };
    productoRepo.createQueryBuilder.mockReturnValue(reservedQuery);
    const producto = (id: number, fechaCompra: string, extra: any = {}) => ({
      id, tipo: 'iphone', envioGrupoId: null,
      valor: { fechaCompra, valorProducto: 100, valorDec: 50, costoEnvio: 10, costoTotal: 400 },
      tracking: [{ id, estado: 'recogido' }],
      ...extra,
    });
    productoRepo.find.mockResolvedValue([
      producto(1, '2025-03-10'),
      producto(2, '2026-01-05'),
      producto(3, '2026-02-01', { tipo: 'accesorios' }),
    ]);
    ventaRepo.find.mockImplementation(async (opts: any) => {
      const ventas = [
        { productoId: 1, precioVenta: 900, ganancia: 300 },
        { productoId: 2, precioVenta: 800, ganancia: 200 },
        { productoId: 3, precioVenta: 50, ganancia: 20 },
      ];
      const ids: number[] | undefined = opts?.where?.productoId?.value;
      return ids ? ventas.filter((v) => ids.includes(v.productoId)) : ventas;
    });

    const r = await service.resumen('2026');

    expect(r.total).toBe(1);
    expect(r.vendido).toBe(1);
    expect(r.totalGastadoUsd).toBe(100);
    expect(r.totalVentaPen).toBe(850);
    expect(r.gananciaPen).toBe(200);
  });

  it('reconoce el año de compra y solo acepta años válidos', () => {
    expect(purchaseYearOf('2025-12-31')).toBe('2025');
    expect(purchaseYearOf(new Date(2026, 0, 1))).toBe('2026');
    expect(purchaseYearOf(null)).toBeNull();
    expect(normalizeResumenYear('2026')).toBe('2026');
    expect(normalizeResumenYear('sin-fecha')).toBe('sin-fecha');
    expect(normalizeResumenYear('todos')).toBeNull();
    expect(normalizeResumenYear("1; DROP")).toBeNull();
  });
});
