import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductoModule } from './producto/producto.module';
import { TrackingModule } from './tracking/tracking.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: 'abc1234',
      database: 'macsomenos',
      synchronize: true,
      autoLoadEntities: true,

      // ----> Activas el logging de SQL
      logging: true,
      logger: 'advanced-console',
    })
    ,
    ProductoModule,
    TrackingModule,
  ],
})
export class AppModule { }
