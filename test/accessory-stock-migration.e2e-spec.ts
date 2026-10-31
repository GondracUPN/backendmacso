import { DataSource } from 'typeorm';
import { SepararAccesoriosSimples1792538100000 } from '../src/migrations/1792538100000-SepararAccesoriosSimples';

const url = process.env.FINANZAS_IT_DB_URL;
if (url && !/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) throw new Error('Usa una base local de pruebas.');

(url ? describe : describe.skip)('Separación de accesorios simples (PostgreSQL)', () => {
  it('separa altas distintas, conserva fotos idénticas y cantidades y permite revertir', async () => {
    const schema = `accessory_stock_${Date.now()}`;
    const ds = await new DataSource({ type: 'postgres', url, schema }).initialize();
    const q = ds.createQueryRunner();
    const migration = new SepararAccesoriosSimples1792538100000();
    await q.startTransaction();
    try {
      await q.query(`CREATE SCHEMA "${schema}"`);
      await q.query(`SET LOCAL search_path TO "${schema}"`);
      await q.query(`CREATE TABLE producto (id integer PRIMARY KEY, tipo text DEFAULT 'accesorios',
        "codigoInventario" integer, "soloInventario" boolean DEFAULT true, "referenciaId" integer,
        vendedor text DEFAULT 'Gonzalo', "stockInicial" integer DEFAULT 1, "stockActual" integer DEFAULT 1)`);
      await q.query(`CREATE TABLE inventario ("productoId" integer PRIMARY KEY, "fotoUrl" text)`);
      await q.query(`INSERT INTO producto (id, "codigoInventario", "stockInicial", "stockActual")
        VALUES (1, 10, 5, 3), (2, 10, 2, 2), (3, 10, 1, 0), (4, 10, 4, 4), (5, 10, 1, 1),
          (6, 10, 1, 1), (7, 70, 1, 1), (8, 70, 1, 1), (9, 90, 1, 1), (10, 90, 1, 1)`);
      await q.query(`UPDATE producto SET "soloInventario" = false WHERE id IN (7, 8)`);
      await q.query(`UPDATE producto SET "referenciaId" = 55 WHERE id IN (9, 10)`);
      await q.query(`INSERT INTO inventario VALUES (1, '/a.jpg'), (2, '/b.jpg'), (3, '/b.jpg'), (4, NULL), (5, ''), (6, ' ')`);
      const before = await q.query('SELECT * FROM producto ORDER BY id');
      await migration.up(q);
      const after = await q.query('SELECT * FROM producto ORDER BY id');
      const codes = after.map((p) => p.codigoInventario);
      expect(codes[0]).toBe(10);
      expect(codes[1]).toBe(codes[2]);
      expect(new Set(codes.slice(0, 6)).size).toBe(5);
      expect(codes.slice(6)).toEqual([70, 70, 90, 90]);
      expect(after.map(({ codigoInventario, ...p }) => p)).toEqual(before.map(({ codigoInventario, ...p }) => p));
      await migration.down(q);
      expect(await q.query('SELECT * FROM producto ORDER BY id')).toEqual(before);
    } finally {
      await q.rollbackTransaction();
      await q.release();
      await ds.destroy();
    }
  });
});
