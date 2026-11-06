import { CatalogSalesIntegrationService } from './catalog-sales-integration.service';
import { operationHash } from '../venta/operation-hash';

test('SKU por referencia encuentra un lote disponible del comprador correcto sin confundirlo con un ID de producto', async () => {
  const lots = [
    { id: 10, tipo: 'accesorios', referenciaId: 5, vendedor: 'Renato', stockActual: 20 },
    { id: 11, tipo: 'accesorios', referenciaId: 5, vendedor: 'Gonzalo', stockActual: 0 },
    { id: 12, tipo: 'accesorios', referenciaId: 5, vendedor: 'Gonzalo', stockActual: 5 },
  ];
  const repo = { find: jest.fn(async () => lots), findOne: jest.fn(async () => ({ id: 100 })) };
  const service = new CatalogSalesIntegrationService({} as any, repo as any, {} as any, {} as any, {} as any);
  const sku = `acc-ref-5-${operationHash('gonzalo').slice(0, 16)}`;
  expect(await (service as any).productFromSku(sku)).toMatchObject({ id: 12, vendedor: 'Gonzalo' });
  expect(repo.findOne).not.toHaveBeenCalled();
  await (service as any).productFromSku('acc-lot-15');
  expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 15, tipo: 'accesorios' } });
  expect(await (service as any).productFromSku('acc-ref-invalida-15')).toBeNull();
});
