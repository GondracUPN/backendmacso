import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { ProductoValor } from '../producto/producto-valor.entity';
import { ProductoDetalle } from '../producto/producto-detalle.entity';
import { Tracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';
import { Producto } from '../producto/producto.entity';

@Module({
  imports: [ TypeOrmModule.forFeature([Producto, ProductoValor, ProductoDetalle, Tracking, Venta]),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}


