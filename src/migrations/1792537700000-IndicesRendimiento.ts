import { MigrationInterface, QueryRunner } from 'typeorm';
import { migrationTable } from '../common/migration-table';

/*
# EXPLAIN ANALYZE: indices candidatos

PostgreSQL desechable (PGlite), datos sinteticos: venta=60000, venta_adelanto=60000, gastos=120000. No usa credenciales ni datos de Neon. Los tiempos son de WASM local y NO representan latencia de produccion.

## idx_perf_venta_producto

Consulta:

```sql
SELECT * FROM venta WHERE "productoId" IN (11,22,33) AND "estadoComercial" <> 'cancelada';
```

Antes:

```text
Seq Scan on venta  (cost=0.00..1358.00 rows=27 width=22) (actual time=0.048..4.479 rows=27.00 loops=1)
  Filter: ((("estadoComercial")::text <> 'cancelada'::text) AND ("productoId" = ANY ('{11,22,33}'::integer[])))
  Rows Removed by Filter: 59973
  Buffers: shared hit=383
Planning:
  Buffers: shared hit=50
Planning Time: 0.211 ms
Execution Time: 4.568 ms
```

Despues:

```text
Bitmap Heap Scan on venta  (cost=13.10..105.65 rows=27 width=22) (actual time=0.267..0.289 rows=27.00 loops=1)
  Recheck Cond: ("productoId" = ANY ('{11,22,33}'::integer[]))
  Filter: (("estadoComercial")::text <> 'cancelada'::text)
  Rows Removed by Filter: 3
  Heap Blocks: exact=11
  Buffers: shared hit=13
  ->  Bitmap Index Scan on idx_perf_venta_producto  (cost=0.00..13.09 rows=30 width=0) (actual time=0.245..0.246 rows=30.00 loops=1)
        Index Cond: ("productoId" = ANY ('{11,22,33}'::integer[]))
        Index Searches: 1
        Buffers: shared hit=2
Planning:
  Buffers: shared hit=13 read=1
Planning Time: 0.411 ms
Execution Time: 0.316 ms
```

## idx_perf_adelanto_producto_created

Consulta:

```sql
SELECT DISTINCT ON ("productoId") * FROM venta_adelanto WHERE "productoId" IN (11,22,33) ORDER BY "productoId", "createdAt" DESC;
```

Antes:

```text
Unique  (cost=1150.74..1150.89 rows=30 width=32) (actual time=8.111..8.132 rows=3.00 loops=1)
  Buffers: shared hit=325
  ->  Sort  (cost=1150.74..1150.81 rows=30 width=32) (actual time=8.089..8.097 rows=30.00 loops=1)
        Sort Key: "productoId", "createdAt" DESC
        Sort Method: quicksort  Memory: 17kB
        Buffers: shared hit=325
        ->  Seq Scan on venta_adelanto  (cost=0.00..1150.00 rows=30 width=32) (actual time=0.016..7.929 rows=30.00 loops=1)
              Filter: ("productoId" = ANY ('{11,22,33}'::integer[]))
              Rows Removed by Filter: 59970
              Buffers: shared hit=325
Planning:
  Buffers: shared hit=46
Planning Time: 0.374 ms
Execution Time: 8.158 ms
```

Despues:

```text
Unique  (cost=104.64..104.79 rows=30 width=32) (actual time=0.064..0.129 rows=3.00 loops=1)
  Buffers: shared hit=18
  ->  Sort  (cost=104.64..104.71 rows=30 width=32) (actual time=0.063..0.110 rows=30.00 loops=1)
        Sort Key: "productoId", "createdAt" DESC
        Sort Method: quicksort  Memory: 17kB
        Buffers: shared hit=18
        ->  Bitmap Heap Scan on venta_adelanto  (cost=13.48..103.90 rows=30 width=32) (actual time=0.025..0.043 rows=30.00 loops=1)
              Recheck Cond: ("productoId" = ANY ('{11,22,33}'::integer[]))
              Heap Blocks: exact=12
              Buffers: shared hit=18
              ->  Bitmap Index Scan on idx_perf_adelanto_producto_created  (cost=0.00..13.47 rows=30 width=0) (actual time=0.015..0.015 rows=30.00 loops=1)
                    Index Cond: ("productoId" = ANY ('{11,22,33}'::integer[]))
                    Index Searches: 2
                    Buffers: shared hit=6
Planning:
  Buffers: shared hit=13 read=1
Planning Time: 0.241 ms
Execution Time: 0.147 ms
```

## idx_perf_gastos_user_fecha_id

Consulta:

```sql
SELECT * FROM gastos WHERE user_id = 42 ORDER BY fecha DESC, id DESC LIMIT 50;
```

Antes:

```text
Limit  (cost=2490.51..2490.63 rows=50 width=35) (actual time=5.954..5.975 rows=50.00 loops=1)
  Buffers: shared hit=964
  ->  Sort  (cost=2490.51..2492.50 rows=798 width=35) (actual time=5.952..5.959 rows=50.00 loops=1)
        Sort Key: fecha DESC, id DESC
        Sort Method: top-N heapsort  Memory: 23kB
        Buffers: shared hit=964
        ->  Seq Scan on gastos  (cost=0.00..2464.00 rows=798 width=35) (actual time=0.009..5.490 rows=800.00 loops=1)
              Filter: (user_id = 42)
              Rows Removed by Filter: 119200
              Buffers: shared hit=964
Planning:
  Buffers: shared hit=46
Planning Time: 0.128 ms
Execution Time: 5.994 ms
```

Despues:

```text
Limit  (cost=0.42..143.89 rows=50 width=35) (actual time=0.099..0.155 rows=50.00 loops=1)
  Buffers: shared hit=53
  ->  Index Scan using idx_perf_gastos_user_fecha_id on gastos  (cost=0.42..2290.20 rows=798 width=35) (actual time=0.097..0.137 rows=50.00 loops=1)
        Index Cond: (user_id = 42)
        Index Searches: 1
        Buffers: shared hit=53
Planning:
  Buffers: shared hit=13 read=1
Planning Time: 0.277 ms
Execution Time: 0.175 ms
```

## idx_perf_gastos_notas

Consulta:

```sql
SELECT * FROM gastos WHERE concepto = 'ingreso' AND notas = '__SALE_ADVANCE__:12:0';
```

Antes:

```text
Seq Scan on gastos  (cost=0.00..2764.00 rows=36 width=35) (actual time=0.010..7.482 rows=20.00 loops=1)
  Filter: ((concepto = 'ingreso'::text) AND (notas = '__SALE_ADVANCE__:12:0'::text))
  Rows Removed by Filter: 119980
  Buffers: shared hit=964
Planning:
  Buffers: shared hit=8
Planning Time: 0.070 ms
Execution Time: 7.516 ms
```

Despues:

```text
Bitmap Heap Scan on gastos  (cost=4.70..128.37 rows=36 width=35) (actual time=0.032..0.062 rows=20.00 loops=1)
  Recheck Cond: (notas = '__SALE_ADVANCE__:12:0'::text)
  Filter: (concepto = 'ingreso'::text)
  Heap Blocks: exact=20
  Buffers: shared hit=23
  ->  Bitmap Index Scan on idx_perf_gastos_notas  (cost=0.00..4.69 rows=36 width=0) (actual time=0.013..0.014 rows=20.00 loops=1)
        Index Cond: (notas = '__SALE_ADVANCE__:12:0'::text)
        Index Searches: 1
        Buffers: shared hit=3
Planning:
  Buffers: shared hit=16 read=1
Planning Time: 0.262 ms
Execution Time: 0.088 ms
```


Decision: indice completo de venta.productoId, porque tambien sirve a consultas historicas
sin estadoComercial. No se agrega ademas uno parcial sin evidencia de beneficio adicional.
El indice de notas se justifica por igualdad. LIKE '__SALE_ADVANCE__:%' empieza con
comodines '_' y no garantiza un prefijo indexable; no se promete aceleracion de ese LIKE.
*/
export class IndicesRendimiento1792537700000 implements MigrationInterface {
  transaction = false;
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_perf_venta_producto ON ${migrationTable(qr, 'venta')} ("productoId")`);
    await qr.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_perf_adelanto_producto_created ON ${migrationTable(qr, 'venta_adelanto')} ("productoId", "createdAt" DESC)`);
    await qr.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_perf_gastos_user_fecha_id ON ${migrationTable(qr, 'gastos')} (user_id, fecha DESC, id DESC)`);
    await qr.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_perf_gastos_notas ON ${migrationTable(qr, 'gastos')} (notas text_pattern_ops)`);
  }
  async down(qr: QueryRunner): Promise<void> {
    for (const name of ['idx_perf_venta_producto', 'idx_perf_adelanto_producto_created', 'idx_perf_gastos_user_fecha_id', 'idx_perf_gastos_notas']) {
      await qr.query(`DROP INDEX CONCURRENTLY IF EXISTS ${migrationTable(qr, name)}`);
    }
  }
}
