import { shouldSynchronizeLocalDatabase } from './db/local-schema';
// app.module.ts
import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { ProductoModule } from './producto/producto.module';
import { AccesoriosModule } from './accesorios/accesorios.module';
import { TrackingModule } from './tracking/tracking.module';
import { VentaModule } from './venta/venta.module';
import { AuthModule } from './auth/auth.module';
import { GastosModule } from './gastos/gastos.module';
import { WalletModule } from './wallet/wallet.module';
import { CardsModule } from './cards/cards.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SchedulesModule } from './schedules/schedules.module';
import { OcrModule } from './ocr/ocr.module';
import { SickwModule } from './sickw/sickw.module';
import { CatalogModule } from './catalog/catalog.module';
import { AppleCatalogModule } from './apple-catalog/apple-catalog.module';
import { InventarioModule } from './inventario/inventario.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EbayPawn } from './ebay-pawn.entity';
import { EbaySearchItem } from './ebay-search-item.entity';
import { EbaySearchState } from './ebay-search-state.entity';
import { EbayViewedItem } from './ebay-viewed-item.entity';
import { EbayBlockedStore } from './ebay-blocked-store.entity';
import { CatalogSalesIntegrationModule } from './catalog-sales-integration/catalog-sales-integration.module';
import { FinanzasModule } from './finanzas/finanzas.module';
import { PerformanceSqlLogger } from './common/request-performance';
import { AppCacheInvalidator } from './common/app-cache';

@Module({
  imports: [
    CacheModule.register({ isGlobal: true, ttl: 60_000 }),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        join(process.cwd(), '.env'),
        join(__dirname, '..', '.env'),
        join(__dirname, '..', '..', '.env'),
      ],
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const nodeEnv = (cfg.get<string>('NODE_ENV') || process.env.NODE_ENV || '').toLowerCase();
        const isProd = nodeEnv === 'production' || nodeEnv === 'prod';
        const syncFlag = (cfg.get<string>('DB_SYNC') || '').toLowerCase();
        // Flujo de esquema del proyecto:
        // - Local (NODE_ENV=development, BD de pruebas): DB_SYNC=true en backend/.env;
        //   TypeORM synchronize aplica los cambios de entidades. No se crean migraciones para local.
        // - Produccion (NODE_ENV=production): synchronize siempre apagado; el esquema se gestiona
        //   con migraciones (start:deploy) aunque DB_SYNC=true.
        const allowSync = syncFlag === 'true' && !isProd;

        if (isProd && syncFlag === 'true') {
          console.log('[DB_SYNC] Ignorado en produccion para evitar cambios de esquema.');
        }

        return {
          type: 'postgres',
          url: cfg.get<string>('DATABASE_URL'),
          ssl: isProd ? { rejectUnauthorized: false } : false,
          extra: { max: 10 },
          autoLoadEntities: true,
          // Ensure all entities are picked up in dev/prod
          entities: [join(__dirname, '/**/*.entity{.ts,.js}')],
          // Desarrollo local sincroniza entidades; DB_SYNC=false lo desactiva. Nunca en producción.
          synchronize: allowSync,
          // Fuerza a usar el schema donde ya estan tus tablas.
          schema: cfg.get<string>('DB_SCHEMA') || 'public',
          // Por defecto solo errores y avisos; DB_LOG=true muestra todo el SQL para depurar.
          logging: cfg.get<string>('DB_LOG') === 'true' ? true : ['error', 'warn'],
          logger: new PerformanceSqlLogger(cfg.get<string>('DB_LOG') === 'true' ? true : ['error', 'warn']),
        };
      },
    }),
    TypeOrmModule.forFeature([EbayPawn, EbaySearchItem, EbaySearchState, EbayViewedItem, EbayBlockedStore]),
    AuthModule,
    GastosModule,
    WalletModule,
    CardsModule,
    VentaModule,
    ProductoModule,
    AccesoriosModule,
    TrackingModule,
    AnalyticsModule,
    SchedulesModule,
    OcrModule,
    SickwModule,
    CatalogModule,
    AppleCatalogModule,
    InventarioModule,
    CatalogSalesIntegrationModule,
    FinanzasModule,
  ],
  controllers: [AppController],
  providers: [AppService, AppCacheInvalidator],
})
export class AppModule {}
