// Uso único tras desplegar: reenvía al catálogo el estado de las ventas ya
// confirmadas, anuladas o rechazadas, para que dejen de figurar como
// «Pendiente en Servicios». Necesita CATALOG_SYNC_URL en el entorno.
//   npm run reconcile:catalog-sales            (hasta 500 eventos)
//   npm run reconcile:catalog-sales -- 100     (límite propio)
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { CatalogSalesIntegrationService } from '../catalog-sales-integration/catalog-sales-integration.service';

async function main() {
  if (!String(process.env.CATALOG_SYNC_URL || '').trim()) {
    console.error('Falta CATALOG_SYNC_URL: no hay a dónde avisar.');
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(CatalogSalesIntegrationService).reconcileCatalogStatuses(Number(process.argv[2]) || 500);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
