import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Venta } from './venta.entity';
import { VentaService } from './venta.service';
import { VentaController } from './venta.controller';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Venta, Producto, ProductoValor])],
  providers: [VentaService],
  controllers: [VentaController],
  exports: [VentaService],
})
export class VentaModule {}
