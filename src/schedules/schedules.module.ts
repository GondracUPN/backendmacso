import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchedulesService } from './schedules.service';
import { SchedulesController } from './schedules.controller';
import { ScheduledCharge } from './scheduled-charge.entity';
import { Gasto } from '../gastos/entities/gasto.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ScheduledCharge, Gasto])],
  providers: [SchedulesService],
  controllers: [SchedulesController],
})
export class SchedulesModule {}

