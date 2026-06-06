import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProductoService } from './producto.service';
import { Producto } from './producto.entity';
import { ProductoDetalle } from './producto-detalle.entity';
import { ProductoValor } from './producto-valor.entity';
import { Tracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';

const repositoryMock = () => ({
  create: jest.fn((value) => value),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  delete: jest.fn(),
  update: jest.fn(),
  createQueryBuilder: jest.fn(),
});

describe('ProductoService', () => {
  let service: ProductoService;
  let productoRepo: ReturnType<typeof repositoryMock>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductoService,
        { provide: getRepositoryToken(Producto), useValue: repositoryMock() },
        { provide: getRepositoryToken(ProductoDetalle), useValue: repositoryMock() },
        { provide: getRepositoryToken(ProductoValor), useValue: repositoryMock() },
        { provide: getRepositoryToken(Tracking), useValue: repositoryMock() },
        { provide: getRepositoryToken(Venta), useValue: repositoryMock() },
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
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
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
});
