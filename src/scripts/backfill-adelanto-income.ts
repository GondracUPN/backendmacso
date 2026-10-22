import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { VentaService } from '../venta/venta.service';

// Ejecutar manualmente en el entorno elegido. Sin --apply solo cuenta reservas.
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(VentaService).backfillAdelantoIncome(process.argv.includes('--apply'));
    console.log(result);
  } finally {
    await app.close();
  }
}
void main().catch(() => { console.error('Fallo el backfill de adelantos.'); process.exitCode = 1; });
