import { VentaService } from './venta.service';

describe('VentaService.completeAdelanto', () => {
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
    const service = new VentaService(
      ventaRepo as any,
      adelantoRepo as any,
      productoRepo as any,
      valorRepo as any,
      cache as any,
    );

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
    const service = new VentaService(
      ventaRepo as any,
      {} as any,
      productoRepo as any,
      {} as any,
      {} as any,
    );

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
    const service = new VentaService(
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
    );

    const result = await service.findSimilarSold(100, 8);

    expect(result.map((sale) => sale.id)).toEqual([20]);
  });
});
