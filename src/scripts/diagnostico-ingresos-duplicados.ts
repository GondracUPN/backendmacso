/** Solo lectura. No importa AppModule ni ejecuta migraciones/seed/arranque.
 * DIAGNOSTICO_DB_URL explícita: nunca toma DATABASE_URL por defecto.
 */
import { Client } from 'pg';

export async function diagnosticar(client: Pick<Client, 'query'>) {
  await client.query('BEGIN READ ONLY');
  try {
    const duplicados = await client.query(`SELECT suelto.id AS ingreso_suelto_id, vinculado.id AS ingreso_vinculado_id,
      vinculado.sale_id AS venta_id, suelto.fecha, suelto.tarjeta, suelto.monto, suelto.user_id
      FROM gastos suelto JOIN gastos vinculado ON vinculado.sale_id IS NOT NULL
      AND vinculado.concepto = 'ingreso' AND vinculado.metodo_pago = 'debito'
      AND suelto.user_id = vinculado.user_id AND suelto.fecha = vinculado.fecha
      AND suelto.moneda = vinculado.moneda AND suelto.tarjeta IS NOT DISTINCT FROM vinculado.tarjeta
      AND suelto.monto = vinculado.monto
      WHERE suelto.sale_id IS NULL AND suelto.concepto = 'ingreso' AND suelto.metodo_pago = 'debito'
      ORDER BY suelto.id, vinculado.id`);
    const sinIngreso = await client.query(`SELECT v.id, v."productoId", v."fechaVenta", v."precioVenta", v.vendedor
      FROM venta v WHERE NOT EXISTS (SELECT 1 FROM gastos g WHERE g.sale_id = v.id AND g.concepto = 'ingreso')
      ORDER BY v.id`);
    return { soloLectura: true, candidatosDuplicados: duplicados.rows, ventasSinIngreso: sinIngreso.rows };
  } finally { await client.query('ROLLBACK'); }
}

async function main() {
  if (!process.env.DIAGNOSTICO_DB_URL) throw new Error('Indica DIAGNOSTICO_DB_URL explícitamente. No se utiliza la base diaria por defecto.');
  const client = new Client({ connectionString: process.env.DIAGNOSTICO_DB_URL });
  await client.connect();
  try { console.log(JSON.stringify(await diagnosticar(client), null, 2)); }
  finally { await client.end(); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
