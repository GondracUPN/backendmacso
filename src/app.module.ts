import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ProductoModule } from './producto/producto.module';
import { TrackingModule } from './tracking/tracking.module';
import { VentaModule } from './venta/venta.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres',
        url: cfg.get<string>('DATABASE_URL'),
        ssl: { rejectUnauthorized: false },
        autoLoadEntities: true,
        synchronize: cfg.get<string>('DB_SYNC') === 'true', // ← crear tablas solo si lo pides
        logging: process.env.NODE_ENV !== 'production',
        logger: 'advanced-console',
      }),
    }),

    VentaModule,
    ProductoModule,
    TrackingModule,
  ],
})
export class AppModule { }
