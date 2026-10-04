import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GastosService } from './gastos.service';
import { GastosController } from './gastos.controller';
import { Gasto } from './entities/gasto.entity';
import { GastoBudget } from './entities/gasto-budget.entity';
import { BolsaInvestment } from './entities/bolsa-investment.entity';
import { ScheduledCharge } from '../schedules/scheduled-charge.entity';
import { CatalogModule } from '../catalog/catalog.module';
import { VentaModule } from '../venta/venta.module';

@Module({
  imports: [TypeOrmModule.forFeature([Gasto, GastoBudget, BolsaInvestment, ScheduledCharge]), CatalogModule, VentaModule],
  controllers: [GastosController],
  providers: [GastosService],
})
export class GastosModule {}
