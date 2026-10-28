import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { InventarioService } from './inventario.service';
import { Inventario } from './inventario.entity';

test('recibir un lote importado con referencia lo saca de tránsito sin cambiar costos ni fechas de recojo previas', async () => {
  const trackingUpdate = jest.fn(async () => ({}));
  const inventory: any = { findOne: async () => ({ productoId: 1 }), save: async (row) => row };
  const manager: any = { getRepository: (entity) => entity === Inventario ? inventory : { update: trackingUpdate } };
  inventory.manager = { transaction: (run) => run(manager) };
  const producto = { id: 1, tipo: 'accesorios', referenciaId: 5, origen: 'accesorio_importado', valor: { costoTotal: 80 },
    tracking: [{ id: 1, estado: 'comprado_sin_tracking' }, { id: 2, estado: 'recogido', fechaRecogido: '2026-10-20' }] };
  const service = new InventarioService(inventory, { findOne: async () => producto } as any, { get: () => '' } as any);
  await service.upsert(1, { enAlmacen: true });
  expect(trackingUpdate).toHaveBeenCalledTimes(1);
  expect(trackingUpdate).toHaveBeenCalledWith(1, expect.objectContaining({ estado: 'recogido' }));
  expect(producto.valor.costoTotal).toBe(80);
});

describe('InventarioService photos', () => {
  const inventarioRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
  const productoRepo = {
    exist: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const configService = {
    get: jest.fn(),
  };

  let service: InventarioService;

  beforeEach(() => {
    jest.clearAllMocks();
    configService.get.mockReturnValue('cloudinary://key:secret@demo');
    productoRepo.exist.mockResolvedValue(true);
    inventarioRepo.save.mockImplementation(async (ficha) => ficha);
    service = new InventarioService(
      inventarioRepo as any,
      productoRepo as any,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('includes every accessory while keeping the normal inventory restrictions for equipment', async () => {
    const queryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    productoRepo.createQueryBuilder.mockReturnValue(queryBuilder);
    inventarioRepo.find.mockResolvedValue([]);

    await service.findDisponibles();

    expect(queryBuilder.where).toHaveBeenCalledWith(
      expect.stringContaining('t.estado = :recogido'),
      { recogido: 'recogido' },
    );
    expect(queryBuilder.where.mock.calls[0][0]).toContain("LOWER(p.tipo) = 'accesorios' OR");
    expect(queryBuilder.where.mock.calls[0][0]).not.toContain('p."stockActual" > 0');
  });

  it('marks the product in storage without completing the photo session', async () => {
    const ficha = { productoId: 42, enAlmacen: false, fotosTomadas: false };
    inventarioRepo.findOne.mockResolvedValue(ficha);
    jest.spyOn(cloudinary.uploader, 'upload').mockResolvedValue({
      secure_url: 'https://res.cloudinary.com/demo/image/upload/portada.jpg',
      public_id: 'macsomenos/inventario/producto-42',
    } as any);

    const result = await service.uploadFoto(42, 'data:image/jpeg;base64,Zm90bw==');

    expect(result).toEqual(expect.objectContaining({
      enAlmacen: true,
      fotosTomadas: false,
    }));
  });

  it('keeps the photo-session state when deleting only the cover photo', async () => {
    const ficha = {
      productoId: 42,
      enAlmacen: true,
      fotosTomadas: true,
      fotoUrl: 'https://res.cloudinary.com/demo/image/upload/portada.jpg',
      fotoPublicId: 'macsomenos/inventario/producto-42',
    };
    inventarioRepo.findOne.mockResolvedValue(ficha);
    jest.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' } as any);

    const result = await service.deleteFoto(42);

    expect(result).toEqual(expect.objectContaining({
      enAlmacen: true,
      fotosTomadas: true,
      fotoUrl: null,
      fotoPublicId: null,
    }));
  });

  it('returns only stored cover photos in the requested product order', async () => {
    inventarioRepo.find.mockResolvedValue([
      { productoId: 42, fotoUrl: 'https://res.cloudinary.com/demo/image/upload/42.jpg' },
      { productoId: 44, fotoUrl: null },
      { productoId: 43, fotoUrl: 'https://res.cloudinary.com/demo/image/upload/43.jpg' },
    ]);

    const result = await service.findPhotoCovers([43, 44, 42]);

    expect(result.map((ficha) => ficha.productoId)).toEqual([43, 42]);
  });

  it('finds every available product with completed photos', async () => {
    const queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { productoId: 53, fotosTomadas: true, fotoUrl: 'https://res.cloudinary.com/demo/image/upload/53.jpg' },
        { productoId: 44, fotosTomadas: true, fotoUrl: null },
        { productoId: 42, fotosTomadas: true, fotoUrl: 'https://res.cloudinary.com/demo/image/upload/42.jpg' },
      ]),
    };
    inventarioRepo.createQueryBuilder.mockReturnValue(queryBuilder);

    const result = await service.findAllAvailablePhotoCovers();

    expect(inventarioRepo.createQueryBuilder).toHaveBeenCalledWith('i');
    expect(queryBuilder.innerJoin).toHaveBeenCalledWith('i.producto', 'p');
    expect(queryBuilder.where).toHaveBeenCalledWith('i."fotosTomadas" = true');
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('i."productoId"', 'DESC');
    expect(result.map((ficha) => ficha.productoId)).toEqual([53, 44, 42]);
  });
});

describe('InventarioService validación por modelo del catálogo Apple', () => {
  // Catálogo real consolidado desde el fixture AppleDB empaquetado (sin red ni BD).
  const { AppleCatalogService } = jest.requireActual('../apple-catalog/apple-catalog.service');
  const failingRepo = { findOne: jest.fn().mockRejectedValue(new Error('sin BD')), find: jest.fn().mockRejectedValue(new Error('sin BD')) };
  const appleCatalog = new AppleCatalogService(failingRepo as any, {} as any, {} as any);
  const VALID_IMEI = '490154203237518';

  const build = (producto: any, ficha: any, duplicates: any[] = []) => {
    const inventarioRepo = {
      findOne: jest.fn().mockResolvedValue(ficha),
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (row) => row),
      query: jest.fn().mockResolvedValue(duplicates),
    };
    const productoRepo = { findOne: jest.fn().mockResolvedValue(producto), save: jest.fn() };
    const config = { get: jest.fn().mockReturnValue('') };
    return { inventarioRepo, service: new InventarioService(inventarioRepo as any, productoRepo as any, config as any, appleCatalog) };
  };
  const mac = { id: 1, tipo: 'macbook', estado: 'usado', detalle: { gama: 'Air', procesador: 'M2', tamano: '13' } };
  const iphone = { id: 2, tipo: 'iphone', estado: 'usado', detalle: { numero: '15', modelo: 'Pro', almacenamiento: '256' } };

  it('rechaza IMEI en una Mac aunque el cliente esté manipulado', async () => {
    const { service } = build(mac, { productoId: 1, accesorios: [] });
    await expect(service.upsert(1, { imei: VALID_IMEI } as any)).rejects.toThrow('IMEI 1 no aplica');
  });

  it('no destruye un IMEI legado al guardar sin cambiarlo y avisa para revisión', async () => {
    const { service } = build(mac, { productoId: 1, accesorios: [], imei: VALID_IMEI });
    const saved: any = await service.upsert(1, { imei: VALID_IMEI, enAlmacen: true } as any);
    expect(saved.imei).toBe(VALID_IMEI);
    expect(saved.avisos[0]).toMatch(/legado/);
  });

  it('detecta IMEI duplicado en otra unidad activa, pero permite el reingreso de una vendida', async () => {
    const active = build(iphone, { productoId: 2, accesorios: [] }, [{ productoId: 9, historico: false }]);
    await expect(active.service.upsert(2, { imei: VALID_IMEI } as any)).rejects.toThrow('producto #9');
    const sold = build(iphone, { productoId: 2, accesorios: [] }, [{ productoId: 9, historico: true }]);
    const saved: any = await sold.service.upsert(2, { imei: VALID_IMEI } as any);
    expect(saved.imei).toBe(VALID_IMEI);
    expect(saved.avisos[0]).toMatch(/reingreso/);
  });

  it('borrador se guarda incompleto; ficha completa exige IMEI 1 e IMEI 2 del iPhone', async () => {
    const draft = build(iphone, { productoId: 2, accesorios: [] });
    const saved: any = await draft.service.upsert(2, { serial: 'f2lxk0abhg7f' } as any);
    expect(saved.serial).toBe('F2LXK0ABHG7F');
    expect(saved.completitud).toMatchObject({ complete: false, missing: expect.arrayContaining(['imei', 'imei2']) });
    await expect(draft.service.upsert(2, { exigirCompleta: true } as any)).rejects.toThrow('Ficha incompleta');
  });

  it('rechaza salud de batería en Mac mini', async () => {
    const { service } = build({ id: 3, tipo: 'macmini', estado: 'usado', detalle: { procesador: 'M4' } }, { productoId: 3, accesorios: [] });
    await expect(service.upsert(3, { saludBateria: 90 } as any)).rejects.toThrow('Salud de batería no aplica');
  });
});
