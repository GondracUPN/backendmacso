import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Producto } from '../producto/producto.entity';
import { Tracking } from './tracking.entity';
import { TrackingService } from './tracking.service';
import { TrackingController } from './tracking.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tracking, Producto]),
  ],
  providers: [TrackingService],
  controllers: [TrackingController],
})
export class TrackingModule {}
