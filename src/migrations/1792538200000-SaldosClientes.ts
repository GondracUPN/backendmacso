import { ensureSaldosClientesProtections } from '../db/saldos-clientes-schema';
import { MigrationInterface, QueryRunner } from 'typeorm';

// Idempotente: en local las tablas pueden existir ya por synchronize (entidades en finanzas/entities/cliente-saldo.entity.ts).

export class SaldosClientes1792538200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS clientes_comerciales (
      id serial PRIMARY KEY, nombre varchar(120) NOT NULL,
      pedido_key varchar(120) UNIQUE,
      clase varchar(15) NOT NULL CHECK (clase IN ('externo','propio','renato')),
      admite_saldo boolean NOT NULL DEFAULT false,
      creado_por int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (NOT admite_saldo OR clase = 'externo'))`);
    await q.query(
      `ALTER TABLE venta ADD COLUMN IF NOT EXISTS cliente_id int REFERENCES clientes_comerciales(id) ON DELETE RESTRICT`,
    );
    await q.query(
      `ALTER TABLE venta_pagos ADD COLUMN IF NOT EXISTS saldo_convertido numeric(12,2) NOT NULL DEFAULT 0 CHECK (saldo_convertido >= 0 AND saldo_convertido <= monto_pen)`,
    );
    await q.query(`CREATE TABLE IF NOT EXISTS cliente_saldos (
      id serial PRIMARY KEY, cliente_id int NOT NULL REFERENCES clientes_comerciales(id) ON DELETE RESTRICT,
      venta_id int NOT NULL REFERENCES venta(id) ON DELETE RESTRICT,
      pago_id int NOT NULL UNIQUE REFERENCES venta_pagos(id) ON DELETE RESTRICT,
      sku int NOT NULL, original numeric(12,2) NOT NULL CHECK (original > 0),
      disponible numeric(12,2) NOT NULL CHECK (disponible >= 0 AND disponible <= original),
      moneda varchar(3) NOT NULL, monto_original numeric(12,2) NOT NULL, equivalente_usd numeric(12,2) NOT NULL,
      tipo_cambio numeric(12,4) NOT NULL CHECK (tipo_cambio > 0),
      fecha date NOT NULL, motivo text NOT NULL, creado_por int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE IF NOT EXISTS cliente_saldo_movimientos (
      id serial PRIMARY KEY, saldo_id int NOT NULL REFERENCES cliente_saldos(id) ON DELETE RESTRICT,
      venta_id int REFERENCES venta(id) ON DELETE RESTRICT,
      pago_id int REFERENCES venta_pagos(id) ON DELETE RESTRICT,
      movimiento_id int REFERENCES movimientos_financieros(id) ON DELETE RESTRICT,
      tipo varchar(15) NOT NULL CHECK (tipo IN ('aplicacion','devolucion')),
      monto numeric(12,2) NOT NULL CHECK (monto > 0), fecha date NOT NULL,
      operacion varchar(120) NOT NULL, operacion_hash varchar(64) NOT NULL, creado_por int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (saldo_id, operacion),
      CHECK ((tipo = 'aplicacion' AND venta_id IS NOT NULL AND pago_id IS NOT NULL) OR
             (tipo = 'devolucion' AND movimiento_id IS NOT NULL)))`);
    await ensureSaldosClientesProtections(q);
    await q.query(
      'CREATE INDEX IF NOT EXISTS cliente_saldos_fifo ON cliente_saldos(cliente_id, fecha, id)',
    );
    await q.query('CREATE INDEX IF NOT EXISTS venta_cliente ON venta(cliente_id)');
    // No se reescriben reclamos anteriores ni se crea un índice que falle por duplicados históricos.
    await q.query(
      'ALTER TABLE reembolsos ADD COLUMN IF NOT EXISTS creado_por int',
    );
    await q.query(
      'ALTER TABLE reembolso_eventos ADD COLUMN IF NOT EXISTS creado_por int',
    );
    const fks = await q.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='reembolso_eventos'::regclass AND confrelid='reembolsos'::regclass AND contype='f'`,
    );
    for (const fk of fks)
      await q.query(
        'ALTER TABLE reembolso_eventos DROP CONSTRAINT "' +
          fk.conname.replace(/"/g, '""') +
          '"',
      );
    await q.query(
      'ALTER TABLE reembolso_eventos ADD CONSTRAINT reembolso_eventos_reclamo_fk FOREIGN KEY (reembolso_id) REFERENCES reembolsos(id) ON DELETE RESTRICT',
    );
  }
  async down(q: QueryRunner): Promise<void> {
    const [row] = await q.query(
      'SELECT count(*)::int AS n FROM cliente_saldos',
    );
    if (row.n)
      throw new Error(
        'Hay historial financiero: esta migración no se puede revertir automáticamente.',
      );
    await q.query('DROP TRIGGER proteger_pago_con_saldo ON venta_pagos');
    await q.query('DROP TRIGGER proteger_ingreso_con_saldo ON gastos');
    await q.query(
      'DROP TRIGGER proteger_devolucion_saldo ON movimientos_financieros',
    );
    await q.query('DROP FUNCTION proteger_pago_con_saldo()');
    await q.query('DROP FUNCTION proteger_ingreso_con_saldo()');
    await q.query('DROP FUNCTION proteger_devolucion_saldo()');
    await q.query('DROP TABLE cliente_saldo_movimientos');
    await q.query('DROP TABLE cliente_saldos');
    await q.query('ALTER TABLE venta_pagos DROP COLUMN saldo_convertido');
    await q.query('ALTER TABLE venta DROP COLUMN cliente_id');
    await q.query('DROP TABLE clientes_comerciales');
    await q.query('ALTER TABLE reembolsos DROP COLUMN creado_por');
    await q.query('ALTER TABLE reembolso_eventos DROP COLUMN creado_por');
  }
}
