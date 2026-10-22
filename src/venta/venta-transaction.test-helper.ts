import { Venta } from './venta.entity';
import { VentaAdelanto } from './venta-adelanto.entity';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { User } from '../auth/entities/user.entity';

export function withTransactionMocks(service: any) {
  const repos = new Map<any, any>([[Venta, service.ventaRepo], [VentaAdelanto, service.adelantoRepo],
    [Producto, service.productoRepo], [ProductoValor, service.valorRepo], [Gasto, service.gastoRepo], [User, service.userRepo]]);
  const manager: any = { getRepository: (entity: any) => repos.get(entity), query: jest.fn(async () => []), transaction: (run: any) => run(manager) };
  service.adelantoRepo.manager = manager;
  // Las pruebas unitarias ejercitan la lógica con repositorios simulados.
  // Rollback y bloqueos reales se comprueban en finanzas.integration.e2e-spec.ts.
  service.transactionManager = manager;
  return service;
}
