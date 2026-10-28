import { BadRequestException, NotFoundException } from '@nestjs/common';
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
      findOne: jest.fn(async () => ({ id: 366, codigoInventario: 366, vendedor: 'Gonzalo' })),
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
      { find: jest.fn(async () => [{ tipo: 'bcp' }]) } as any,
      { findOne: jest.fn(async () => ({ id: 1 })) } as any,
      ventaService as any,
    );
    return { service, dataSource, productoRepo, ventaService, queries };
  };

  it('reutiliza la venta existente y descarta la anulacion anterior al revender', async () => {
    const { service, ventaService, queries } = makeService();

    await service.confirm(event.id, 3.75, 'bcp');

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

    await service.confirm(event.id, 3.75, 'bcp');

    expect(ventaService.create).toHaveBeenCalledWith(expect.objectContaining({ productoId: 366 }));
    expect(queries.some(({ sql, params }) => sql.includes("'confirmed'") && params[1] === 92)).toBe(true);
  });

  it('usa el cambio del sistema y registra la deuda x500 al confirmar', async () => {
    const { service, ventaService } = makeService({
      updateError: new NotFoundException('Venta 91 no encontrada'),
    });
    await service.confirm(event.id, undefined, 'bcp', 'debt');
    expect(ventaService.create).toHaveBeenCalledWith(expect.objectContaining({
      tipoCambio: 3.7,
      incomePaymentType: 'debt',
      incomeSku: 'MS-366',
    }));
  });

  it('acepta el cobro directo de la venta', async () => {
    const { service, ventaService } = makeService({
      updateError: new NotFoundException('Venta 91 no encontrada'),
    });
    await service.confirm(event.id, 3.75, 'bcp', 'direct');
    expect(ventaService.create).toHaveBeenCalledWith(expect.objectContaining({ incomePaymentType: 'direct' }));
  });
});

describe('CatalogSalesIntegrationService.paymentOptions', () => {
  it('ofrece solo cuentas de debito para recibir una venta del catalogo', async () => {
    const dataSource = { query: jest.fn(async () => [{ id: 'event-id', sku: 'MS-366' }]) };
    const productoRepo = {
      findOne: jest.fn(async () => ({ id: 366, codigoInventario: 366, vendedor: 'Gonzalo' })),
    };
    const cardRepo = { find: jest.fn(async () => [{ tipo: 'bcp_visa' }, { tipo: 'io' }]) };
    const userRepo = { findOne: jest.fn(async () => ({ id: 1 })) };
    const service = new CatalogSalesIntegrationService(
      dataSource as any,
      productoRepo as any,
      cardRepo as any,
      userRepo as any,
      {} as any,
    );
    jest.spyOn(service, 'ensureTable').mockResolvedValue();

    await expect(service.paymentOptions('event-id')).resolves.toEqual({
      owner: 'gonzalo',
      seller: 'Gonzalo',
      cards: [{ tipo: 'bcp' }, { tipo: 'interbank' }, { tipo: 'bbva' }],
    });
    expect(cardRepo.find).not.toHaveBeenCalled();
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
    const service = new CatalogSalesIntegrationService(dataSource as any, {} as any, {} as any, {} as any, {} as any);
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
    const service = new CatalogSalesIntegrationService(dataSource as any, {} as any, {} as any, {} as any, {} as any);
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

describe('CatalogSalesIntegrationService aviso al catalogo', () => {
  const makeService = () => {
    const state: any = {
      id: 'evt-1', eventId: 'catalog-evt-1', eventType: 'sale.created', sku: 'MS-366',
      status: 'pending_confirmation', amount: '2200.00', soldAt: '2026-09-02T12:00:00.000Z', createdAt: '2026-09-02T12:01:00.000Z',
    };
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('WHERE "id" = $1 LIMIT 1')) return [{ ...state }];
        if (sql.includes(`SET "status" = 'confirmed'`)) state.status = 'confirmed';
        if (sql.includes(`"status" IN ('confirmed', 'cancelled', 'rejected')`)) {
          return [{ eventId: 'a', status: 'confirmed' }, { eventId: 'b', status: 'cancelled' }];
        }
        return [];
      }),
    };
    const service = new CatalogSalesIntegrationService(
      dataSource as any,
      { findOne: jest.fn(async () => ({ id: 366, codigoInventario: 366, vendedor: 'Gonzalo' })) } as any,
      { find: jest.fn(async () => [{ tipo: 'bcp' }]) } as any,
      { findOne: jest.fn(async () => ({ id: 1 })) } as any,
      { update: jest.fn(), create: jest.fn(async () => ({ id: 92 })) } as any,
    );
    const notify = jest.spyOn(service as any, 'notifyCatalogStatus').mockResolvedValue(true);
    return { service, notify };
  };

  it('avisa al catalogo cuando se confirma la venta', async () => {
    const { service, notify } = makeService();
    await service.confirm('evt-1', 3.75, 'bcp');
    expect(notify).toHaveBeenCalledWith('catalog-evt-1', 'confirmed');
  });

  it('reenvia los estados finales para reconciliar ventas antiguas', async () => {
    const { service, notify } = makeService();
    const result = await service.reconcileCatalogStatuses();
    expect(notify).toHaveBeenCalledWith('a', 'confirmed');
    expect(notify).toHaveBeenCalledWith('b', 'cancelled');
    expect(result).toEqual(expect.objectContaining({ total: 2, notified: 2, ok: true }));
  });

  it('se detiene tras varios fallos seguidos', async () => {
    const { service, notify } = makeService();
    notify.mockResolvedValue(false);
    const result = await service.reconcileCatalogStatuses(500, 1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ ok: false, stoppedEarly: true, notified: 0 }));
  });
});

describe('CatalogSalesIntegrationService venta editada en el catalogo', () => {
  const payload = {
    eventType: 'sale.updated',
    catalogSaleId: 'sale-1',
    sku: 'MS-366',
    title: 'MacBook',
    amount: 2350,
    exchangeRate: 3.75,
    soldAt: '2026-09-03T17:00:00.000Z',
  };

  const makeService = (original: any, options?: { updateError?: Error }) => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('WHERE "id" = $1 LIMIT 1')) return [{ id: 'upd-row', eventType: 'sale.updated', status: 'update_applied' }];
        if (sql.includes(`"eventType" = 'sale.created'`) && sql.includes('ORDER BY')) return original ? [original] : [];
        return [];
      }),
    };
    const ventaService = {
      update: options?.updateError
        ? jest.fn(async () => { throw options.updateError; })
        : jest.fn(async () => ({ id: 91 })),
      create: jest.fn(),
      remove: jest.fn(),
    };
    const service = new CatalogSalesIntegrationService(dataSource as any, {} as any, {} as any, {} as any, ventaService as any);
    jest.spyOn(service, 'ensureTable').mockResolvedValue();
    const notify = jest.spyOn(service as any, 'notifyCatalogStatus').mockResolvedValue(true);
    return { service, ventaService, queries, notify };
  };

  const originalUpdate = (queries: Array<{ sql: string; params: unknown[] }>) =>
    queries.filter(({ sql, params }) => sql.includes('UPDATE') && params[0] === 'created-1');

  it('corrige el precio de un alta aun pendiente sin tocar la venta real', async () => {
    const { service, ventaService, queries } = makeService({ id: 'created-1', status: 'pending_confirmation', payload: { amount: 2200 } });

    const result = await service.receive('upd-evt', payload);

    expect(result).toEqual({ ok: true, status: 'update_applied_to_pending' });
    expect(ventaService.update).not.toHaveBeenCalled();
    expect(originalUpdate(queries)[0].params[1]).toBe(2350);
  });

  it('actualiza precio y fecha de una venta ya confirmada', async () => {
    const { service, ventaService, queries, notify } = makeService({ id: 'created-1', status: 'confirmed', remoteVentaId: 91 });

    const result = await service.receive('upd-evt', payload);

    expect(result).toEqual({ ok: true, status: 'update_applied' });
    expect(ventaService.update).toHaveBeenCalledWith(91, { precioVenta: 2350, fechaVenta: '2026-09-03' });
    expect(originalUpdate(queries)).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('aplica cada edicion aunque el catalogo repita el mismo eventId', async () => {
    const { service, ventaService } = makeService({ id: 'created-1', status: 'confirmed', remoteVentaId: 91 });

    await service.receive('upd-evt', payload);
    await service.receive('upd-evt', { ...payload, amount: 2400 });

    expect(ventaService.update).toHaveBeenCalledTimes(2);
    expect(ventaService.update).toHaveBeenLastCalledWith(91, expect.objectContaining({ precioVenta: 2400 }));
  });

  it('informa el error cuando Servicios no puede cambiar la venta sola', async () => {
    const { service, queries } = makeService(
      { id: 'created-1', status: 'confirmed', remoteVentaId: 91 },
      { updateError: new BadRequestException('Para cambiar el precio de una venta con pagos combinados, indica también los nuevos importes de cobro.') },
    );

    await expect(service.receive('upd-evt', payload)).rejects.toThrow(/pagos combinados/);
    expect(originalUpdate(queries)).toHaveLength(0);
    expect(queries.some(({ params }) => params.includes('update_failed'))).toBe(true);
  });

  it('no hace nada si la venta ya fue anulada', async () => {
    const { service, ventaService } = makeService({ id: 'created-1', status: 'superseded_by_cancellation' });
    await expect(service.receive('upd-evt', payload)).resolves.toEqual({ ok: true, status: 'update_ignored' });
    expect(ventaService.update).not.toHaveBeenCalled();
  });

  it('pide reintentar si el alta aun no llego', async () => {
    const { service } = makeService(null);
    await expect(service.receive('upd-evt', payload)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('confirmar o rechazar una edicion nunca anula la venta', async () => {
    const { service, ventaService } = makeService(null);
    await expect(service.confirm('upd-row', 3.75, 'bcp')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.reject('upd-row')).rejects.toBeInstanceOf(BadRequestException);
    expect(ventaService.remove).not.toHaveBeenCalled();
  });
});
