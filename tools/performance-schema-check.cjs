
// Requiere npm run build y un modulo PGlite instalado fuera de la imagen de produccion.
const { PGlite } = require(process.env.PERF_PGLITE_MODULE || '@electric-sql/pglite');
const { DataSource } = require('typeorm');
const { join } = require('node:path');
const fs = require('node:fs');
async function main() {
 const db = new PGlite();
 // Solo construye metadatos: nunca inicializa un DataSource ni lee .env.
 const ds = new DataSource({type:'postgres',entities:[join(__dirname,'../dist/src/**/*.entity.js')]});
 await ds.buildMetadatas();
 const added = new Set(['cuentas_financieras','venta_pagos','pago_liquidaciones','movimientos_financieros','reembolsos','reembolso_eventos','venta_devoluciones']);
 for (const table of ds.entityMetadatas.filter(t=>!added.has(t.tableName))) {
  const columns=table.columns.map(c=> {
   let type=ds.driver.normalizeType(c);
   if(type==='enum'||type==='simple-enum')type='text';
   if(c.isArray) type+='[]';
   return '"'+c.databaseName.replaceAll('"','""')+'" '+type+(c.isPrimary?' PRIMARY KEY':'');
  });
  await db.exec('CREATE TABLE "'+table.tableName+'" ('+columns.join(',')+')');
 }
 const qr={connection:{options:{schema:'public'}},query:async(sql,params)=> (await db.query(sql,params)).rows,
  getTable:async()=>({foreignKeys:(await db.query("SELECT conname FROM pg_constraint WHERE conrelid='venta'::regclass AND contype='f'")).rows.map(r=>({name:r.conname,columnNames:['productoId'],onDelete:'RESTRICT'}))}),
  dropForeignKey:async()=>{throw Error('FK inesperada en fixture')},
 };
 const dir=join(__dirname,'../dist/src/migrations');
 const migrations=fs.readdirSync(dir).filter(f=>f.endsWith('.js')).sort().map(f=>new (Object.values(require(join(dir,f)))[0])());
 for(let round=0;round<2;round++)for(const migration of migrations){
  const tx=migration.transaction!==false;
  if(tx)await db.exec('BEGIN');
  try{await migration.up(qr);if(tx)await db.exec('COMMIT');}
  catch(e){if(tx)await db.exec('ROLLBACK');throw e;}
 }
 const indexes=await db.query("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname LIKE 'idx_perf_%'");
 if(indexes.rows[0].n!==4)throw Error('Faltan indices de rendimiento');
 await db.close();console.log('Migraciones SQL verificadas dos veces en PostgreSQL desechable; sin Neon.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
