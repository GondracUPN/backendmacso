import { MigrationInterface, QueryRunner } from 'typeorm';
import { migrationTable } from '../common/migration-table';

export class SepararAccesoriosSimples1792538100000 implements MigrationInterface {
  name = 'SepararAccesoriosSimples1792538100000';

  async up(q: QueryRunner): Promise<void> {
    const products = migrationTable(q, 'producto');
    const inventory = migrationTable(q, 'inventario');
    const backup = migrationTable(q, 'accesorios_codigos_separados');
    await q.query(`LOCK TABLE ${products} IN SHARE ROW EXCLUSIVE MODE`);
    await q.query(`CREATE TABLE ${backup} (
      "productoId" integer PRIMARY KEY, "codigoAnterior" integer NULL, "codigoNuevo" integer NOT NULL
    )`);
    // Una cantidad > 1 dentro del mismo producto se conserva íntegra. Solo se
    // separan altas distintas; una foto no vacía idéntica conserva el grupo.
    await q.query(`WITH candidates AS (
      SELECT p.id, p."codigoInventario", COALESCE(p."codigoInventario", p.id) AS code,
        lower(btrim(COALESCE(p.vendedor, ''))) AS owner,
        CASE WHEN NULLIF(btrim(i."fotoUrl"), '') IS NOT NULL THEN 'photo:' || btrim(i."fotoUrl")
          ELSE 'product:' || p.id::text END AS identity
      FROM ${products} p LEFT JOIN ${inventory} i ON i."productoId" = p.id
      WHERE lower(p.tipo) = 'accesorios' AND p."soloInventario" = true AND p."referenciaId" IS NULL
    ), groups AS (
      SELECT code, owner, identity, min(id) AS first_id FROM candidates GROUP BY code, owner, identity
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY code, owner ORDER BY first_id) AS position FROM groups
    ), moved AS (
      SELECT *, (SELECT COALESCE(max(GREATEST(id, COALESCE("codigoInventario", id))), 0) FROM ${products})
        + row_number() OVER (ORDER BY first_id) AS new_code FROM ranked WHERE position > 1
    )
    INSERT INTO ${backup} ("productoId", "codigoAnterior", "codigoNuevo")
      SELECT c.id, c."codigoInventario", m.new_code FROM candidates c
      JOIN moved m ON m.code = c.code AND m.owner = c.owner AND m.identity = c.identity`);
    await q.query(`UPDATE ${products} p SET "codigoInventario" = b."codigoNuevo"
      FROM ${backup} b WHERE p.id = b."productoId"`);
  }

  async down(q: QueryRunner): Promise<void> {
    const backup = migrationTable(q, 'accesorios_codigos_separados');
    await q.query(`UPDATE ${migrationTable(q, 'producto')} p SET "codigoInventario" = b."codigoAnterior"
      FROM ${backup} b WHERE p.id = b."productoId" AND p."codigoInventario" = b."codigoNuevo"`);
    await q.query(`DROP TABLE ${backup}`);
  }
}
