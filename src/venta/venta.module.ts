import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Venta } from './venta.entity';
import { VentaAdelanto } from './venta-adelanto.entity';
import { VentaDevolucion } from './venta-devolucion.entity';
import { VentaService } from './venta.service';
import { VentaController } from './venta.controller';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { User } from '../auth/entities/user.entity';
import { FinanzasCoreModule } from '../finanzas/finanzas-core.module';

@Module({
  imports: [ TypeOrmModule.forFeature([Venta, VentaAdelanto, VentaDevolucion, Producto, ProductoValor, Gasto, User]), FinanzasCoreModule],
  providers: [VentaService],
  controllers: [VentaController],
  exports: [VentaService],
})
export class VentaModule {}
