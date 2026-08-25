import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Producto } from '../producto/producto.entity';
import { VentaModule } from '../venta/venta.module';
import { CatalogSalesIntegrationController } from './catalog-sales-integration.controller';
import { CatalogSalesIntegrationService } from './catalog-sales-integration.service';

@Module({
  imports: [TypeOrmModule.forFeature([Producto]), VentaModule],
  controllers: [CatalogSalesIntegrationController],
  providers: [CatalogSalesIntegrationService],
})
export class CatalogSalesIntegrationModule {}
