import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GastosService } from './gastos.service';
import { GastosController } from './gastos.controller';
import { Gasto } from './entities/gasto.entity';
import { ScheduledCharge } from '../schedules/scheduled-charge.entity';
import { CatalogModule } from '../catalog/catalog.module';

@Module({
  imports: [TypeOrmModule.forFeature([Gasto, ScheduledCharge]), CatalogModule],
  controllers: [GastosController],
  providers: [GastosService],
})
export class GastosModule {}
