import { VentaService } from './venta.service';
import { Producto } from '../producto/producto.entity';

describe('VentaService.create', () => {
  it('usa el costo unitario fijo del lote con la compra más antigua', async () => {
    const locked = {
      id: 40,
      tipo: 'accesorios',
      codigoInventario: 12,
      stockInicial: 3,
      stockActual: 3,
      vendedor: 'Gonzalo',
      valor: { valorProducto: 90, costoEnvio: 10, fechaCompra: '2026-07-01' },
      tracking: [{ fechaRecogido: '2026-06-15' }],
    };
    const firstLot = { id: 12, tipo: 'accesorios', codigoInventario: 12, stockInicial: 5, stockActual: 5, valor: { valorProducto: 100, costoEnvio: 20, fechaCompra: '2026-05-01' }, tracking: [{ fechaRecogido: '2026-07-10' }] };
    const lots = [
      firstLot,
      locked,
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
    const service = new VentaService(
      ventaRepo as any,
      {} as any,
      productoRepo as any,
      {} as any,
      cache as any,
    );

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
      ganancia: 132,
      distribucionStock: [{ productoId: 12, cantidad: 2 }],
    }));
    expect(firstLot.stockActual).toBe(3);
    expect(locked.stockActual).toBe(3);
    expect(transactionProductRepo.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: expect.anything() },
    }));
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
    const service = new VentaService(
      ventaRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      gastoRepo as any,
      userRepo as any,
    );

    const result = await service.create({
      productoId: 44,
      tipoCambio: 3.75,
      fechaVenta: '2026-08-04',
      precioVenta: 3000,
      incomeBank: 'bcp',
    });

    expect(result).toBe(existing);
    expect(gastoRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      userId: 1,
      concepto: 'ingreso',
      monto: '3000.00',
      fecha: '2026-08-04',
      tarjeta: 'bcp',
      notas: '__SALE_INCOME__:44',
    }));
  });

  it('devuelve la venta existente sin crear otra para el mismo producto', async () => {
    const existing = { id: 91, productoId: 42, precioVenta: 1500 };
    const ventaRepo = {
      findOne: jest.fn(async () => existing),
      create: jest.fn(),
      save: jest.fn(),
    };
    const productoRepo = { findOne: jest.fn() };
    const service = new VentaService(
      ventaRepo as any,
      {} as any,
      productoRepo as any,
      {} as any,
      {} as any,
    );

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
    const service = new VentaService(
      ventaRepo as any,
      {} as any,
      { findOne: jest.fn(async () => ({ id: 43, vendedor: 'Gonzalo', valor })) } as any,
      { save: jest.fn(async (data) => data) } as any,
      { del: jest.fn(async () => undefined) } as any,
    );

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
