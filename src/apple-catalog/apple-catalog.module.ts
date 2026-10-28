import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogItem } from '../catalog/catalog-item.entity';
import { AppleCatalogController } from './apple-catalog.controller';
import { AppleCatalogService } from './apple-catalog.service';
import { AppleDbProvider } from './appledb.provider';
import { EveryMacProvider } from './everymac.provider';

@Module({
  imports: [TypeOrmModule.forFeature([CatalogItem])],
  controllers: [AppleCatalogController],
  providers: [AppleCatalogService, AppleDbProvider, EveryMacProvider],
  exports: [AppleCatalogService],
})
export class AppleCatalogModule {}
