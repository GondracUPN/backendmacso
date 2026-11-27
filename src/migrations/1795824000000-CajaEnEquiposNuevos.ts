import { MigrationInterface, QueryRunner } from 'typeorm';

/** Los equipos nuevos siempre incluyen caja: completa los registros existentes (idempotente). */
export class CajaEnEquiposNuevos1795824000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`UPDATE producto
      SET accesorios = array_prepend('Caja', array_remove(array_remove(COALESCE(accesorios, '{}'), 'Ninguno'), 'Caja'))
      WHERE lower(trim(estado)) = 'nuevo' AND lower(tipo) <> 'accesorios'
        AND (accesorios IS NULL OR NOT ('Caja' = ANY(accesorios)))`);
    await q.query(`UPDATE inventario i
      SET accesorios = array_prepend('Caja', array_remove(array_remove(COALESCE(i.accesorios, '{}'), 'Ninguno'), 'Caja'))
      FROM producto p
      WHERE p.id = i."productoId" AND lower(trim(p.estado)) = 'nuevo' AND lower(p.tipo) <> 'accesorios'
        AND cardinality(COALESCE(i.accesorios, '{}')) > 0 AND NOT ('Caja' = ANY(i.accesorios))`);
  }

  async down() { /* Conserva la caja añadida a los equipos nuevos. */ }
}
