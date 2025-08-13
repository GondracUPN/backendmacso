import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Producto } from './producto.entity';
import { ProductoDetalle } from './producto-detalle.entity';
import { ProductoValor } from './producto-valor.entity';
import { ProductoService } from './producto.service';
import { ProductoController } from './producto.controller';
import { Tracking } from '../tracking/tracking.entity'; // ✅ importar tracking

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Producto,
      ProductoDetalle,
      ProductoValor,
      Tracking, // ✅ agregar aquí
    ]),
  ],
  controllers: [ProductoController],
  providers: [ProductoService],
})
export class ProductoModule {}
