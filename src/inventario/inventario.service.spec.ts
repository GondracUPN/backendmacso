import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { InventarioService } from './inventario.service';

describe('InventarioService photos', () => {
  const inventarioRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
  const productoRepo = {
    exist: jest.fn(),
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
});
