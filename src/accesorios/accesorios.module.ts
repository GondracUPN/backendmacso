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
import { AccesorioCatalogo } from './accesorio-catalogo.entity';
import { AccesoriosCatalogoService } from './accesorios-catalogo.service';
import { AccesoriosCatalogoController, AccesoriosCatalogoSyncController } from './accesorios-catalogo.controller';

@Module({ imports: [TypeOrmModule.forFeature([AccesorioCatalogo, AccesorioReferencia, AccesorioIngreso, AccesorioVinculoAuditoria, AccesorioVinculoOperacion, AccesorioVinculoPropuesta]), ProductoModule, VentaModule],
  providers: [AccesoriosService, AccesoriosCatalogoService, VinculosService], controllers: [AccesoriosController, AccesoriosCatalogoController, AccesoriosCatalogoSyncController] })
export class AccesoriosModule {}
