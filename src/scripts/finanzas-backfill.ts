/**
 * Importa como pagos SIN VERIFICAR los cobros que Gastos ya registra para ventas
 * anteriores al sistema financiero. Por defecto solo simula (no escribe nada).
 *
 *   npm run finanzas:backfill            # simulación
 *   npm run finanzas:backfill -- --apply # aplica (respaldar antes)
 *
 * Usa DATABASE_URL del entorno; revisa a qué base apunta antes de aplicar.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { FinanzasModule } from '../finanzas/finanzas.module';
import { FinanzasService } from '../finanzas/finanzas.service';
import { FinanzasAnalisisService } from '../finanzas/finanzas-analisis.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(String(process.env.DATABASE_URL))
        ? false
        : { rejectUnauthorized: false },
      autoLoadEntities: true,
      entities: [join(__dirname, '../**/*.entity{.ts,.js}')],
      synchronize: false,
      logging: false,
    }),
    FinanzasModule,
  ],
})
class BackfillModule {}

async function main() {
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(BackfillModule, {
    logger: ['error', 'warn'],
  });
  try {
    const ds = app.get(DataSource);
    const totals = async () =>
      (
        await ds.query(
          `SELECT count(*)::int AS ventas, sum("precioVenta")::text AS precio, sum(ganancia)::text AS ganancia,
              min("fechaVenta")::text AS desde, max("fechaVenta")::text AS hasta FROM venta`,
        )
      )[0];
    const host = (() => {
      try {
        return new URL(String(process.env.DATABASE_URL)).host;
      } catch {
        return 'desconocido';
      }
    })();
    console.log(
      `[finanzas-backfill] base: ${host} · modo: ${apply ? 'APLICAR' : 'simulación'}`,
    );
    const antes = await totals();
    const result = await app.get(FinanzasService).backfillHistorico(!apply);
    const despues = await totals();
    console.log(
      JSON.stringify(
        { result, ventasAntes: antes, ventasDespues: despues },
        null,
        2,
      ),
    );
    if (JSON.stringify(antes) !== JSON.stringify(despues))
      throw new Error('Los totales de ventas cambiaron: revisar.');
    const t0 = Date.now();
    const year = new Date().getFullYear();
    const analisis = await app
      .get(FinanzasAnalisisService)
      .analisis({ from: `${year}-01-01`, to: `${year}-12-31` });
    console.log(
      `[finanzas-backfill] análisis anual en ${Date.now() - t0} ms`,
      JSON.stringify(analisis.resumen),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
