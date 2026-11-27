import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Los accesorios nuevos (excepto micas) vienen con caja. Idempotente.
 * No toca lotes fusionados ni lotes legados de catálogo (referencia sin empaque), cuyo SKU agrupado depende de empaque NULL.
 */
export class EmpaqueConCajaAccesoriosNuevos1795910400000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`UPDATE producto p SET "empaqueAccesorio" = 'con_caja'
      WHERE lower(p.tipo) = 'accesorios' AND lower(trim(p.estado)) = 'nuevo'
        AND p."fusionAccesorioId" IS NULL
        AND (p."empaqueAccesorio" = 'sin_indicar' OR (p."empaqueAccesorio" IS NULL AND p."referenciaId" IS NULL))
        AND NOT EXISTS (SELECT 1 FROM producto_detalle d WHERE d.id = p."detalleId"
          AND lower(trim(COALESCE(d.gama, ''))) IN ('mica', 'micas'))`);
  }

  async down() { /* Conserva el empaque asignado. */ }
}
