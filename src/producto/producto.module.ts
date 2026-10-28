import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Producto } from './producto.entity';
import { ProductoDetalle } from './producto-detalle.entity';
import { ProductoValor } from './producto-valor.entity';
import { ProductoService } from './producto.service';
import { ProductoController } from './producto.controller';
import { Tracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';
import { PersonalEshopex } from './personal-eshopex.entity';
import { Inventario } from '../inventario/inventario.entity';
import { AppleCatalogModule } from '../apple-catalog/apple-catalog.module';

@Module({
  imports: [ TypeOrmModule.forFeature([
      Producto,
      ProductoDetalle,
      ProductoValor,
      Tracking,
      Venta,
      PersonalEshopex,
      Inventario,
    ]),
    AppleCatalogModule,
  ],
  controllers: [ProductoController],
  providers: [ProductoService],
  exports: [ProductoService],
})
export class ProductoModule {}
