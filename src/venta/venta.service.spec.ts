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
});
