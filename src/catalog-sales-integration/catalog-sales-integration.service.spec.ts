import { NotFoundException } from '@nestjs/common';
import { CatalogSalesIntegrationService } from './catalog-sales-integration.service';

describe('CatalogSalesIntegrationService.confirm', () => {
  const event = {
    id: 'new-event',
    eventType: 'sale.created',
    sku: 'MS-366',
    status: 'pending_confirmation',
    amount: '2200.00',
    soldAt: '2026-09-02T12:00:00.000Z',
    createdAt: '2026-09-02T12:01:00.000Z',
  };

  const makeService = (options?: { updateError?: Error }) => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('WHERE "id" = $1 LIMIT 1')) return [event];
        if (sql.includes('FROM "public"."catalog_sale_events"') && sql.includes("'sale.cancelled'")) {
          return [{ id: 'old-cancellation', remoteVentaId: 91 }];
        }
        return [];
      }),
    };
    const productoRepo = {
      findOne: jest.fn(async () => ({ id: 366, codigoInventario: 366 })),
    };
    const ventaService = {
      update: options?.updateError
        ? jest.fn(async () => { throw options.updateError; })
        : jest.fn(async () => ({ id: 91 })),
      create: jest.fn(async () => ({ id: 92 })),
    };
    const service = new CatalogSalesIntegrationService(
      dataSource as any,
      productoRepo as any,
      ventaService as any,
    );
    return { service, dataSource, productoRepo, ventaService, queries };
  };

  it('reutiliza la venta existente y descarta la anulacion anterior al revender', async () => {
    const { service, ventaService, queries } = makeService();

    await service.confirm(event.id, 3.75);

    expect(ventaService.update).toHaveBeenCalledWith(91, expect.objectContaining({
      productoId: 366,
      tipoCambio: 3.75,
      precioVenta: 2200,
      fechaVenta: '2026-09-02',
    }));
    expect(ventaService.create).not.toHaveBeenCalled();
    expect(queries.some(({ sql }) => sql.includes("'superseded_by_resale'"))).toBe(true);
    expect(queries.some(({ sql, params }) => sql.includes("'confirmed'") && params[1] === 91)).toBe(true);
  });

  it('recrea la venta si la anulacion ya la habia eliminado', async () => {
    const { service, ventaService, queries } = makeService({
      updateError: new NotFoundException('Venta 91 no encontrada'),
    });

    await service.confirm(event.id, 3.75);

    expect(ventaService.create).toHaveBeenCalledWith(expect.objectContaining({ productoId: 366 }));
    expect(queries.some(({ sql, params }) => sql.includes("'confirmed'") && params[1] === 92)).toBe(true);
  });
});

describe('CatalogSalesIntegrationService.receive', () => {
  it('vuelve a poner como pendiente una venta rechazada que se reenvia', async () => {
    const dataSource = {
      query: jest.fn()
        .mockResolvedValueOnce([{
          id: 'stored-event',
          status: 'rejected',
          exchangeRate: 0,
        }])
        .mockResolvedValueOnce([]),
    };
    const service = new CatalogSalesIntegrationService(dataSource as any, {} as any, {} as any);
    jest.spyOn(service, 'ensureTable').mockResolvedValue();

    const result = await service.receive('delivery-event', {
      eventType: 'sale.created',
      catalogSaleId: 'catalog-sale',
      sku: 'MS-366',
      amount: 2100,
      soldAt: '2026-08-24T17:00:00.000Z',
    });

    expect(result).toMatchObject({ status: 'pending_confirmation', reopened: true });
    expect(dataSource.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("'pending_confirmation'"),
      expect.arrayContaining(['stored-event']),
    );
  });

  it('reabre una venta confirmada si su venta remota fue eliminada despues', async () => {
    const dataSource = {
      query: jest.fn()
        .mockResolvedValueOnce([{
          id: 'stored-event',
          status: 'confirmed',
          remoteVentaId: 91,
        }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    };
    const service = new CatalogSalesIntegrationService(
      dataSource as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service, 'ensureTable').mockResolvedValue();

    const result = await service.receive('delivery-event', {
      eventType: 'sale.created',
      catalogSaleId: 'catalog-sale',
      sku: 'MS-366',
      amount: 2100,
      exchangeRate: 3.365,
      soldAt: '2026-08-24T17:00:00.000Z',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'pending_confirmation',
      duplicate: true,
      reopened: true,
    });
    expect(dataSource.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM "public"."venta"'),
      [91],
    );
    expect(dataSource.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("'pending_confirmation'"),
      expect.arrayContaining(['stored-event']),
    );
  });
});

describe('CatalogSalesIntegrationService.setExchangeRate', () => {
  it('guarda el tipo de cambio sin confirmar la venta', async () => {
    const event = {
      id: 'event-id',
      eventType: 'sale.created',
      status: 'pending_confirmation',
      payload: { sku: 'MS-366', exchangeRate: 0 },
    };
    const dataSource = {
      query: jest.fn()
        .mockResolvedValueOnce([event])
        .mockResolvedValueOnce([]),
    };
    const service = new CatalogSalesIntegrationService(dataSource as any, {} as any, {} as any);
    jest.spyOn(service, 'ensureTable').mockResolvedValue();

    const result = await service.setExchangeRate(event.id, 3.75);

    expect(result).toEqual({ ok: true, status: 'pending_confirmation', exchangeRate: 3.75 });
    expect(dataSource.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('"exchangeRate" = $2'),
      expect.arrayContaining(['event-id', 3.75]),
    );
  });
});
