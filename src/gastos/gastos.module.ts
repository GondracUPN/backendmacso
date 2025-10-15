import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GastosService } from './gastos.service';
import { GastosController } from './gastos.controller';
import { Gasto } from './entities/gasto.entity';
import { ScheduledCharge } from '../schedules/scheduled-charge.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Gasto, ScheduledCharge])],
  controllers: [GastosController],
  providers: [GastosService],
})
export class GastosModule {}
