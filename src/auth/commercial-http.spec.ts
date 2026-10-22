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
      controllers: [VentaController, CatalogSalesIntegrationController],
      providers: [JwtStrategy, { provide: ConfigService, useValue: { get: () => 'audit-http-secret' } },
        { provide: VentaService, useValue: svc },
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
  test('catálogo requiere su credencial; funciona sin JWT con credencial válida', async () => {
    await request(app.getHttpServer()).post('/integrations/catalog-sales/events').send({}).expect(401);
    await request(app.getHttpServer()).post('/integrations/catalog-sales/events')
      .set('x-sync-secret', 'audit-catalog-secret').send({}).expect(201);
  });
});
