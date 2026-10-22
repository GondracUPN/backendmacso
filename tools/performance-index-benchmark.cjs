const {PGlite}=require(process.env.PERF_PGLITE_MODULE || '@electric-sql/pglite');
const fs=require('fs');
(async()=>{
const db=new PGlite();
await db.exec(`
CREATE TABLE venta (id int PRIMARY KEY, "productoId" int, "fechaVenta" date, "estadoComercial" varchar(20));
CREATE TABLE venta_adelanto (id int PRIMARY KEY, "productoId" int, "createdAt" timestamp, "completadoAt" timestamp, "canceladoAt" timestamp);
CREATE TABLE gastos (id int PRIMARY KEY, user_id int, fecha date, concepto text, notas text);
INSERT INTO venta SELECT i, i % 6000, '2026-01-01'::date + (i%290), CASE WHEN i%9=0 THEN 'cancelada' ELSE 'entregada' END FROM generate_series(1,60000) i;
INSERT INTO venta_adelanto SELECT i, i % 6000, '2026-01-01'::timestamp + i * interval '1 minute', null, null FROM generate_series(1,60000) i;
INSERT INTO gastos SELECT i, i%150, '2026-01-01'::date + (i%290), 'ingreso', CASE WHEN i%3=0 THEN '__SALE_ADVANCE__:' || (i%6000) || ':0' ELSE 'nota ' || i END FROM generate_series(1,120000) i;
ANALYZE;
`);
const cases=[
 ['idx_perf_venta_producto',`SELECT * FROM venta WHERE "productoId" IN (11,22,33) AND "estadoComercial" <> 'cancelada'`,`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_perf_venta_producto ON venta ("productoId")`],
 ['idx_perf_adelanto_producto_created',`SELECT DISTINCT ON ("productoId") * FROM venta_adelanto WHERE "productoId" IN (11,22,33) ORDER BY "productoId", "createdAt" DESC`,`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_perf_adelanto_producto_created ON venta_adelanto ("productoId", "createdAt" DESC)`],
 ['idx_perf_gastos_user_fecha_id',`SELECT * FROM gastos WHERE user_id = 42 ORDER BY fecha DESC, id DESC LIMIT 50`,`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_perf_gastos_user_fecha_id ON gastos (user_id, fecha DESC, id DESC)`],
 ['idx_perf_gastos_notas',`SELECT * FROM gastos WHERE concepto = 'ingreso' AND notas = '__SALE_ADVANCE__:12:0'`,`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_perf_gastos_notas ON gastos (notas text_pattern_ops)`],
];
let output='# EXPLAIN ANALYZE: indices candidatos\n\nPostgreSQL desechable (PGlite), datos sinteticos: venta=60000, venta_adelanto=60000, gastos=120000. No usa credenciales ni datos de Neon. Los tiempos son de WASM local y NO representan latencia de produccion.\n\n';
for(const [name,query,index]of cases){const before=await db.query('EXPLAIN (ANALYZE, BUFFERS) '+query);await db.exec(index);const after=await db.query('EXPLAIN (ANALYZE, BUFFERS) '+query);output+=`## ${name}\n\nConsulta:\n\n\`\`\`sql\n${query};\n\`\`\`\n\nAntes:\n\n\`\`\`text\n${before.rows.map(r=>r['QUERY PLAN']).join('\n')}\n\`\`\`\n\nDespues:\n\n\`\`\`text\n${after.rows.map(r=>r['QUERY PLAN']).join('\n')}\n\`\`\`\n\n`;}
fs.writeFileSync(require('path').join(__dirname, '../docs/EXPLAIN_RENDIMIENTO.md'),output);await db.close();console.log('EXPLAIN guardado; 4 indices probados con CONCURRENTLY');
})().catch(e=>{console.error(e.message);process.exitCode=1});

