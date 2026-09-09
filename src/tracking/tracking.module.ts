import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Producto } from '../producto/producto.entity';
import { Tracking } from './tracking.entity';
import { TrackingService } from './tracking.service';
import { TrackingController } from './tracking.controller';
import { PersonalEshopex } from '../producto/personal-eshopex.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Tracking, Producto, PersonalEshopex])],
  providers: [TrackingService],
  controllers: [TrackingController],
})
export class TrackingModule {}
