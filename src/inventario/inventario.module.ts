import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Producto } from '../producto/producto.entity';
import { InventarioController } from './inventario.controller';
import { Inventario } from './inventario.entity';
import { InventarioService } from './inventario.service';

@Module({
  imports: [TypeOrmModule.forFeature([Inventario, Producto])],
  controllers: [InventarioController],
  providers: [InventarioService],
})
export class InventarioModule {}
