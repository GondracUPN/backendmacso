import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductoModule } from '../producto/producto.module';
import { VentaModule } from '../venta/venta.module';
import { AccesorioIngreso } from './accesorio-ingreso.entity';
import { AccesorioReferencia } from './accesorio-referencia.entity';
import { AccesoriosService } from './accesorios.service';
import { AccesoriosController } from './accesorios.controller';
import { AccesorioVinculoAuditoria, AccesorioVinculoOperacion, AccesorioVinculoPropuesta } from './accesorio-vinculo.entity';
import { VinculosService } from './vinculos.service';

@Module({ imports: [TypeOrmModule.forFeature([AccesorioReferencia, AccesorioIngreso, AccesorioVinculoAuditoria, AccesorioVinculoOperacion, AccesorioVinculoPropuesta]), ProductoModule, VentaModule],
  providers: [AccesoriosService, VinculosService], controllers: [AccesoriosController] })
export class AccesoriosModule {}
