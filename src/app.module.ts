// app.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { ProductoModule } from './producto/producto.module';
import { TrackingModule } from './tracking/tracking.module';
import { VentaModule } from './venta/venta.module';
import { AuthModule } from './auth/auth.module';
import { GastosModule } from './gastos/gastos.module';
import { WalletModule } from './wallet/wallet.module';
import { CardsModule } from './cards/cards.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SchedulesModule } from './schedules/schedules.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(__dirname, '..', '.env'), join(process.cwd(), '.env')],
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const nodeEnv = (cfg.get<string>('NODE_ENV') || process.env.NODE_ENV || '').toLowerCase();
        const isProd = nodeEnv === 'production' || nodeEnv === 'prod';
        const syncFlag = (cfg.get<string>('DB_SYNC') || '').toLowerCase();
        // Safety-first: never sync unless explicitly requested outside production.
        const allowSync = syncFlag === 'true' && !isProd;

        if (isProd && syncFlag === 'true') {
          console.log('[DB_SYNC] Ignorado en produccion para evitar cambios de esquema.');
        }

        return {
          type: 'postgres',
          url: cfg.get<string>('DATABASE_URL'),
          ssl: isProd ? { rejectUnauthorized: false } : false,
          autoLoadEntities: true,
          // Ensure all entities are picked up in dev/prod
          entities: [join(__dirname, '/**/*.entity{.ts,.js}')],
          // Solo sincroniza si DB_SYNC=true y nunca en produccion.
          synchronize: allowSync,
          // Fuerza a usar el schema donde ya estan tus tablas.
          schema: cfg.get<string>('DB_SCHEMA') || 'public',
          // (Opcional) deja logging solo mientras verificas en prod.
          logging: cfg.get<string>('DB_LOG') === 'true' || !isProd,
          logger: 'advanced-console',
        };
      },
    }),
    AuthModule,
    GastosModule,
    WalletModule,
    CardsModule,
    VentaModule,
    ProductoModule,
    TrackingModule,
    AnalyticsModule,
    SchedulesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
