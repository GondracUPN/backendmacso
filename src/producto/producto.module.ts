import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Producto } from './producto.entity';
import { ProductoDetalle } from './producto-detalle.entity';
import { ProductoValor } from './producto-valor.entity';
import { ProductoService } from './producto.service';
import { ProductoController } from './producto.controller';
import { Tracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';

@Module({
  imports: [
    CacheModule.register(),
    TypeOrmModule.forFeature([
      Producto,
      ProductoDetalle,
      ProductoValor,
      Tracking,
      Venta,
    ]),
  ],
  controllers: [ProductoController],
  providers: [ProductoService],
})
export class ProductoModule {}
