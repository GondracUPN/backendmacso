import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { JwtStrategy } from './strategies/jwt.strategy';
import { VentaController } from '../venta/venta.controller';
import { VentaService } from '../venta/venta.service';
import { CatalogSalesIntegrationController } from '../catalog-sales-integration/catalog-sales-integration.controller';
import { CatalogSalesIntegrationService } from '../catalog-sales-integration/catalog-sales-integration.service';
import { AccesoriosCatalogoController, AccesoriosCatalogoSyncController } from '../accesorios/accesorios-catalogo.controller';
import { AccesoriosCatalogoService } from '../accesorios/accesorios-catalogo.service';
import { AppleCatalogService } from '../apple-catalog/apple-catalog.service';

describe('permisos HTTP comerciales (sin base de datos)', () => {
  let app: any;
  const svc = { create: jest.fn(async () => ({ id: 1 })), findAll: async () => [], resultadoVenta: async (v: any) => v };
  const jwt = new JwtService({ secret: 'audit-http-secret' });
  const token = (role: string) => jwt.sign({ sub: 1, username: 'test', role });
  let previous: string | undefined;
  beforeAll(async () => {
    previous = process.env.CATALOG_SYNC_SECRET;
    process.env.CATALOG_SYNC_SECRET = 'audit-catalog-secret';
    const module = await Test.createTestingModule({
      controllers: [VentaController, CatalogSalesIntegrationController, AccesoriosCatalogoController, AccesoriosCatalogoSyncController],
      providers: [JwtStrategy, { provide: ConfigService, useValue: { get: () => 'audit-http-secret' } },
        { provide: VentaService, useValue: svc },
        { provide: AppleCatalogService, useValue: { accessoryCompatibility: async () => [
          { id: 'iphone-13-mini', family: 'iphone', range: 'Mini', label: 'iPhone 13 mini', screen: '5.4″', chip: 'A15', year: 2021 },
        ] } },
        { provide: AccesoriosCatalogoService, useValue: { list: async () => [], select: async () => [], withdrawFromCatalog: async () => ({ok:true,seleccionado:false}) } },
        { provide: CatalogSalesIntegrationService, useValue: { receive: async () => ({ ok: true }) } }],
    }).compile();
    app = module.createNestApplication(); await app.init();
  });
  afterAll(async () => {
    await app.close();
    if (previous === undefined) delete process.env.CATALOG_SYNC_SECRET;
    else process.env.CATALOG_SYNC_SECRET = previous;
  });
  test('sin token: 401 sin escrituras', async () => {
    await request(app.getHttpServer()).post('/ventas').send({}).expect(401);
    expect(svc.create).not.toHaveBeenCalled();
  });
  test('cliente puede leer pero no escribir', async () => {
    await request(app.getHttpServer()).get('/ventas').auth(token('user'), { type: 'bearer' }).expect(200);
    await request(app.getHttpServer()).post('/ventas').auth(token('user'), { type: 'bearer' }).send({}).expect(403);
    expect(svc.create).not.toHaveBeenCalled();
  });
  test('admin puede escribir', async () => {
    await request(app.getHttpServer()).post('/ventas').auth(token('admin'), { type: 'bearer' }).send({}).expect(201);
  });
  test('selección y listado de publicación de accesorios requieren admin', async () => {
    await request(app.getHttpServer()).post('/accesorios/catalogo/seleccion').send({}).expect(401);
    await request(app.getHttpServer()).post('/accesorios/catalogo/seleccion').auth(token('user'), { type: 'bearer' }).send({}).expect(403);
    await request(app.getHttpServer()).get('/accesorios/catalogo').auth(token('user'), { type: 'bearer' }).expect(403);
    await request(app.getHttpServer()).post('/accesorios/catalogo/seleccion').auth(token('admin'), { type: 'bearer' }).send({ keys: ['lot-10'], seleccionado: true }).expect(201);
  });
  test('retiro de accesorios exige el secreto de integración, sin JWT de usuario', async () => {
    await request(app.getHttpServer()).post('/integrations/catalog-accessories/withdraw').send({sku:'acc-lot-509'}).expect(401);
    await request(app.getHttpServer()).post('/integrations/catalog-accessories/withdraw').auth(token('admin'), {type:'bearer'}).send({sku:'acc-lot-509'}).expect(401);
    await request(app.getHttpServer()).post('/integrations/catalog-accessories/withdraw').set('x-sync-secret','audit-catalog-secret').send({sku:'acc-lot-509'}).expect(201).expect({ok:true,seleccionado:false});
  });
  test('catálogo requiere su credencial; funciona sin JWT con credencial válida', async () => {
    await request(app.getHttpServer()).post('/integrations/catalog-sales/events').send({}).expect(401);
    await request(app.getHttpServer()).post('/integrations/catalog-sales/events')
      .set('x-sync-secret', 'audit-catalog-secret').send({}).expect(201);
  });
  test('la integración solo ofrece los modelos compatibles con una credencial de catálogo', async () => {
    const path = '/integrations/catalog-accessories/compatible-models';
    await request(app.getHttpServer()).get(path).expect(401);
    const result = await request(app.getHttpServer()).get(path).set('x-sync-secret', 'audit-catalog-secret').expect(200);
    expect(result.body).toEqual([expect.objectContaining({ id: 'iphone-13-mini', family: 'iphone', screen: '5.4″' })]);
  });
});
