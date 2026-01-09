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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(__dirname, '..', '.env'), join(process.cwd(), '.env')],
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const isProd = process.env.NODE_ENV === 'production';
        return {
          type: 'postgres',
          url: cfg.get<string>('DATABASE_URL'),
          ssl: isProd ? { rejectUnauthorized: false } : false,
          autoLoadEntities: true,
          // Ensure all entities are picked up in dev/prod
          entities: [join(__dirname, '/**/*.entity{.ts,.js}')],
          // En desarrollo, si DB_SYNC no está definido, se habilita por defecto
          synchronize: (cfg.get<string>('DB_SYNC') ?? (isProd ? 'false' : 'true')) === 'true',
          // 👇 fuerza a usar el schema donde ya están tus tablas
          schema: cfg.get<string>('DB_SCHEMA') || 'public',

          // (opcional) deja logging solo mientras verificas en prod:
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
})
export class AppModule {}
