import { DataSource, QueryRunner } from 'typeorm';
import { migrationTable, migrationSchema } from '../common/migration-table';

export async function ensureSistemaFinanciero(q: QueryRunner): Promise<void> {
    const hadConciliacion = await q.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'venta' AND column_name = 'conciliacionHistorica'`,
    );

    // — venta —
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "fechaReserva" date`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "precioLista" numeric(12,2)`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "descuento" numeric(12,2) NOT NULL DEFAULT 0`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "moneda" varchar(3) NOT NULL DEFAULT 'PEN'`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "estadoComercial" varchar(20) NOT NULL DEFAULT 'entregada'`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "conciliacionHistorica" varchar(20) NOT NULL DEFAULT 'no_aplica'`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "conciliacionNota" text`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "conciliadaAt" timestamptz`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "costoPendiente" boolean NOT NULL DEFAULT false`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "grupoOperacion" varchar(64)`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "ventaRapida" boolean NOT NULL DEFAULT false`,
    );
    await q.query(
      `ALTER TABLE "venta" ADD COLUMN IF NOT EXISTS "operacionKey" varchar(120)`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_venta_operacion_key" ON "venta" ("operacionKey") WHERE "operacionKey" IS NOT NULL`,
    );
    if (!hadConciliacion.length) {
      // Solo la primera vez: todo lo existente queda pendiente de conciliación histórica.
      await q.query(`UPDATE "venta" SET "conciliacionHistorica" = 'pendiente'`);
    }
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_venta_fecha_venta" ON "venta" ("fechaVenta")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_venta_grupo_operacion" ON "venta" ("grupoOperacion") WHERE "grupoOperacion" IS NOT NULL`,
    );

    // — venta_adelanto —
    await q.query(
      `ALTER TABLE "venta_adelanto" ADD COLUMN IF NOT EXISTS "canceladoAt" timestamptz`,
    );
    await q.query(
      `ALTER TABLE "venta_adelanto" ADD COLUMN IF NOT EXISTS "fechaDevolucion" date`,
    );
    await q.query(
      `ALTER TABLE "venta_adelanto" ADD COLUMN IF NOT EXISTS "montoDevuelto" numeric(12,2)`,
    );
    await q.query(
      `ALTER TABLE "venta_adelanto" ADD COLUMN IF NOT EXISTS "motivoCancelacion" text`,
    );

    // — producto —
    await q.query(
      `ALTER TABLE "producto" ADD COLUMN IF NOT EXISTS "origen" varchar(30)`,
    );
    await q.query(
      `ALTER TABLE "producto" ADD COLUMN IF NOT EXISTS "cierreMotivo" varchar(30)`,
    );

    // — gastos —
    await q.query(
      `ALTER TABLE "gastos" ADD COLUMN IF NOT EXISTS "clasificacion_financiera" varchar(30)`,
    );
    await q.query(
      `ALTER TABLE "gastos" ADD COLUMN IF NOT EXISTS "venta_vinculada_id" integer`,
    );
    await q.query(
      `ALTER TABLE "gastos" ADD COLUMN IF NOT EXISTS "producto_vinculado_id" integer`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_gastos_venta_vinculada" ON "gastos" ("venta_vinculada_id") WHERE "venta_vinculada_id" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_gastos_sale_id" ON "gastos" ("sale_id") WHERE "sale_id" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_gastos_fecha" ON "gastos" ("fecha")`,
    );

    // — cuentas_financieras —
    await q.query(`
      CREATE TABLE IF NOT EXISTS "cuentas_financieras" (
        "id" SERIAL PRIMARY KEY,
        "codigo" varchar(40) NOT NULL,
        "nombre" varchar(80) NOT NULL,
        "tipo" varchar(20) NOT NULL,
        "moneda" varchar(3) NOT NULL DEFAULT 'PEN',
        "legacy_codigo" varchar(32),
        "activo" boolean NOT NULL DEFAULT true,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "chk_cuenta_tipo" CHECK ("tipo" IN ('efectivo','banco','billetera','tercero','procesador','tarjeta_credito','proveedor')),
        CONSTRAINT "chk_cuenta_moneda" CHECK ("moneda" IN ('PEN','USD'))
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_cuentas_financieras_codigo" ON "cuentas_financieras" ("codigo")`,
    );

    // Cuentas base: corresponden a los códigos que ya usa Gastos (no son movimientos ni saldos).
    await q.query(`
      INSERT INTO "cuentas_financieras" ("codigo","nombre","tipo","moneda","legacy_codigo") VALUES
        ('efectivo','Efectivo en caja','efectivo','PEN','efectivo'),
        ('bcp','BCP','banco','PEN','bcp'),
        ('interbank','Interbank','banco','PEN','interbank'),
        ('bbva','BBVA','banco','PEN','bbva'),
        ('procesador','Pasarela / POS por liquidar','procesador','PEN',NULL),
        ('repartidor','Repartidor (efectivo por entregar)','tercero','PEN',NULL),
        ('tc_interbank','Tarjeta Interbank','tarjeta_credito','PEN','interbank'),
        ('tc_bcp_amex','Tarjeta BCP Amex','tarjeta_credito','PEN','bcp_amex'),
        ('tc_bcp_visa','Tarjeta BCP Visa','tarjeta_credito','PEN','bcp_visa'),
        ('tc_visa_qore','Tarjeta Visa Qore','tarjeta_credito','PEN','visa_qore'),
        ('tc_bbva','Tarjeta BBVA','tarjeta_credito','PEN','bbva'),
        ('tc_io','Tarjeta iO','tarjeta_credito','PEN','io'),
        ('tc_saga','Tarjeta Saga','tarjeta_credito','PEN','saga')
      ON CONFLICT ("codigo") DO NOTHING`);

    // — venta_pagos —
    await q.query(`
      CREATE TABLE IF NOT EXISTS "venta_pagos" (
        "id" SERIAL PRIMARY KEY,
        "venta_id" integer,
        "adelanto_id" integer,
        "monto" numeric(12,2) NOT NULL,
        "moneda" varchar(3) NOT NULL DEFAULT 'PEN',
        "tipo_cambio" numeric(10,4),
        "monto_pen" numeric(12,2) NOT NULL,
        "fecha_pago" date,
        "metodo" varchar(20) NOT NULL,
        "cuenta_origen" varchar(80),
        "referencia" varchar(120),
        "estado" varchar(30) NOT NULL,
        "requiere_liquidacion" boolean NOT NULL DEFAULT false,
        "comision_estimada" numeric(12,2) NOT NULL DEFAULT 0,
        "fecha_liquidacion_estimada" date,
        "cuenta_receptora_id" integer REFERENCES "cuentas_financieras"("id") ON DELETE SET NULL,
        "es_adelanto" boolean NOT NULL DEFAULT false,
        "origen" varchar(20) NOT NULL DEFAULT 'manual',
        "verificado" boolean NOT NULL DEFAULT true,
        "gasto_id" integer,
        "idempotency_key" varchar(120) NOT NULL,
        "observacion" text,
        "anulado_at" timestamptz,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "chk_venta_pagos_monto" CHECK ("monto" > 0 AND "monto_pen" > 0),
        CONSTRAINT "chk_venta_pagos_destino" CHECK ("venta_id" IS NOT NULL OR "adelanto_id" IS NOT NULL),
        CONSTRAINT "chk_venta_pagos_moneda" CHECK ("moneda" IN ('PEN','USD')),
        CONSTRAINT "chk_venta_pagos_tc" CHECK ("moneda" = 'PEN' OR "tipo_cambio" > 0)
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_venta_pagos_idempotency" ON "venta_pagos" ("idempotency_key")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_venta_pagos_venta" ON "venta_pagos" ("venta_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_venta_pagos_adelanto" ON "venta_pagos" ("adelanto_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_venta_pagos_fecha" ON "venta_pagos" ("fecha_pago")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_venta_pagos_gasto" ON "venta_pagos" ("gasto_id") WHERE "gasto_id" IS NOT NULL`,
    );

    // — pago_liquidaciones —
    await q.query(`
      CREATE TABLE IF NOT EXISTS "pago_liquidaciones" (
        "id" SERIAL PRIMARY KEY,
        "pago_id" integer NOT NULL REFERENCES "venta_pagos"("id") ON DELETE CASCADE,
        "tipo" varchar(30) NOT NULL DEFAULT 'liquidacion',
        "fecha" date NOT NULL,
        "monto_bruto" numeric(12,2) NOT NULL,
        "comision" numeric(12,2) NOT NULL DEFAULT 0,
        "monto_neto" numeric(12,2) NOT NULL,
        "cuenta_id" integer REFERENCES "cuentas_financieras"("id") ON DELETE SET NULL,
        "referencia" varchar(120),
        "idempotency_key" varchar(120) NOT NULL,
        "nota" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "chk_liq_tipo" CHECK ("tipo" IN ('liquidacion','devolucion','contracargo','reversion_contracargo')),
        CONSTRAINT "chk_liq_montos" CHECK ("monto_bruto" > 0 AND "comision" >= 0 AND "monto_neto" >= 0 AND "monto_neto" + "comision" = "monto_bruto")
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_pago_liquidaciones_idempotency" ON "pago_liquidaciones" ("idempotency_key")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_pago_liquidaciones_pago" ON "pago_liquidaciones" ("pago_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_pago_liquidaciones_fecha" ON "pago_liquidaciones" ("fecha")`,
    );

    // — movimientos_financieros —
    await q.query(`
      CREATE TABLE IF NOT EXISTS "movimientos_financieros" (
        "id" SERIAL PRIMARY KEY,
        "fecha" date NOT NULL,
        "tipo" varchar(20) NOT NULL,
        "cuenta_origen_id" integer REFERENCES "cuentas_financieras"("id") ON DELETE RESTRICT,
        "cuenta_destino_id" integer REFERENCES "cuentas_financieras"("id") ON DELETE RESTRICT,
        "monto" numeric(12,2) NOT NULL,
        "moneda" varchar(3) NOT NULL DEFAULT 'PEN',
        "tipo_cambio" numeric(10,4),
        "monto_pen" numeric(12,2) NOT NULL,
        "metodo" varchar(20),
        "referencia" varchar(120),
        "nota" text,
        "idempotency_key" varchar(120) NOT NULL,
        "created_by" integer,
        "anulado_at" timestamptz,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "chk_mov_tipo" CHECK ("tipo" IN ('transferencia','ajuste')),
        CONSTRAINT "chk_mov_monto" CHECK ("monto" > 0 AND "monto_pen" > 0),
        CONSTRAINT "chk_mov_cuentas" CHECK ("cuenta_origen_id" IS NOT NULL OR "cuenta_destino_id" IS NOT NULL),
        CONSTRAINT "chk_mov_distintas" CHECK ("cuenta_origen_id" IS DISTINCT FROM "cuenta_destino_id")
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_movimientos_idempotency" ON "movimientos_financieros" ("idempotency_key")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_movimientos_fecha" ON "movimientos_financieros" ("fecha")`,
    );

    // — reembolsos —
    await q.query(`
      CREATE TABLE IF NOT EXISTS "reembolsos" (
        "id" SERIAL PRIMARY KEY,
        "producto_id" integer NOT NULL REFERENCES "producto"("id") ON DELETE RESTRICT,
        "estado" varchar(30) NOT NULL DEFAULT 'incidencia',
        "moneda" varchar(3) NOT NULL DEFAULT 'PEN',
        "tipo_cambio_compra" numeric(10,4),
        "costo_original" numeric(12,2) NOT NULL,
        "gastos_adicionales" numeric(12,2) NOT NULL DEFAULT 0,
        "monto_reclamado" numeric(12,2) NOT NULL DEFAULT 0,
        "monto_aprobado" numeric(12,2),
        "cuenta_devolucion_id" integer REFERENCES "cuentas_financieras"("id") ON DELETE SET NULL,
        "fecha_incidencia" date,
        "fecha_cierre" date,
        "referencia" varchar(120),
        "motivo" text,
        "version" integer NOT NULL DEFAULT 1,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "chk_reembolso_estado" CHECK ("estado" IN ('en_transito','incidencia','reclamo_abierto','aprobado','reembolso_parcial','recibido','rechazado','perdida_definitiva'))
      )`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_reembolsos_producto" ON "reembolsos" ("producto_id")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "reembolso_eventos" (
        "id" SERIAL PRIMARY KEY,
        "reembolso_id" integer NOT NULL REFERENCES "reembolsos"("id") ON DELETE CASCADE,
        "tipo" varchar(20) NOT NULL,
        "fecha" date NOT NULL,
        "monto" numeric(12,2),
        "moneda" varchar(3) NOT NULL DEFAULT 'PEN',
        "tipo_cambio" numeric(10,4),
        "monto_pen" numeric(12,2),
        "cuenta_id" integer REFERENCES "cuentas_financieras"("id") ON DELETE SET NULL,
        "gasto_id" integer,
        "nota" text,
        "idempotency_key" varchar(120) NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_reembolso_eventos_idempotency" ON "reembolso_eventos" ("idempotency_key")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_reembolso_eventos_reembolso" ON "reembolso_eventos" ("reembolso_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_reembolso_eventos_fecha" ON "reembolso_eventos" ("fecha")`,
    );
}

export async function ensureIntegridadOperaciones(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "operacionHash" varchar(64)`);
    // La unicidad de equipos se asegura bloqueando la fila del producto; un índice
    // parcial no puede consultar el tipo de otra tabla y bloquearía accesorios.
}

export async function ensureDestinoIngresoVenta(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} ADD COLUMN IF NOT EXISTS sale_cuenta_id integer`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} ADD COLUMN IF NOT EXISTS sale_metodo varchar(20)`);
}

export async function ensureDevolucionesComerciales(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'producto')} ADD COLUMN IF NOT EXISTS "archivadoAt" timestamptz`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'producto')} ADD COLUMN IF NOT EXISTS "archivoMotivo" text`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "costoDevuelto" numeric(12,2) NOT NULL DEFAULT 0`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "precioDevuelto" numeric(12,2) NOT NULL DEFAULT 0`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "cantidadDevuelta" integer NOT NULL DEFAULT 0`);
    await qr.query(`CREATE TABLE IF NOT EXISTS ${migrationTable(qr, 'venta_devoluciones')} (
      id serial PRIMARY KEY, "ventaId" integer NOT NULL REFERENCES ${migrationTable(qr, 'venta')}(id) ON DELETE RESTRICT,
      cantidad integer NOT NULL CHECK (cantidad > 0), monto numeric(12,2) NOT NULL CHECK (monto >= 0),
      "costoRecuperado" numeric(12,2) NOT NULL DEFAULT 0, destino varchar(20) NOT NULL,
      "precioAnulado" numeric(12,2) NOT NULL DEFAULT 0,
      fecha date NOT NULL, motivo text NOT NULL, "cuentaId" integer, "userId" integer,
      "operacionKey" varchar(100) NOT NULL UNIQUE, "operacionHash" varchar(64) NOT NULL,
      lotes jsonb NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta_devoluciones')} ADD COLUMN IF NOT EXISTS "precioAnulado" numeric(12,2) NOT NULL DEFAULT 0`);
    const table = await qr.getTable(`${migrationSchema(qr)}.venta`);
    const productKeys = (table?.foreignKeys || []).filter(
      (fk) => fk.columnNames.length === 1 && fk.columnNames[0] === 'productoId',
    );
    if (!productKeys.length || productKeys.some((fk) => fk.onDelete !== 'RESTRICT')) {
      for (const fk of productKeys) await qr.dropForeignKey(table!, fk);
      await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD CONSTRAINT venta_producto_restrict_fk FOREIGN KEY ("productoId") REFERENCES ${migrationTable(qr, 'producto')}(id) ON DELETE RESTRICT`);
    }
}

export async function ensureCostosPendientes(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "costoCompletadoTotal" numeric(12,2)`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "costoDocumento" text`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "costoCompletadoPor" integer`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "costoCompletadoAt" timestamptz`);
}

export async function ensureProgramacionesIdempotentes(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'scheduled_charges')} ADD COLUMN IF NOT EXISTS anchor_day smallint`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} ADD COLUMN IF NOT EXISTS scheduled_charge_id integer`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} ADD COLUMN IF NOT EXISTS scheduled_period date`);
    await qr.query(`CREATE UNIQUE INDEX IF NOT EXISTS gastos_programacion_periodo_unique ON ${migrationTable(qr, 'gastos')} (scheduled_charge_id, scheduled_period) WHERE scheduled_charge_id IS NOT NULL AND scheduled_period IS NOT NULL`);
}

/** Ajustes idempotentes de arranque; no usa el ejecutor ni la tabla de migraciones. */
export async function ensureFinancialSchema(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    await qr.connect();
    await qr.startTransaction();
    const schema = migrationSchema(qr);
    // El search_path es local a esta transaccion y conexion, incluso con un pool.
    await qr.query(`SELECT set_config('search_path', $1, true)`, [
      `"${schema.replace(/"/g, '""')}"`,
    ]);
    // Serializa despliegues concurrentes que crean las mismas columnas.
    await qr.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${schema}:financial-schema`,
    ]);
    await ensureSistemaFinanciero(qr);
    await ensureIntegridadOperaciones(qr);
    await ensureDestinoIngresoVenta(qr);
    await ensureDevolucionesComerciales(qr);
    await ensureCostosPendientes(qr);
    await ensureProgramacionesIdempotentes(qr);
    await qr.commitTransaction();
  } catch (error) {
    if (qr.isTransactionActive) await qr.rollbackTransaction();
    throw error;
  } finally {
    await qr.release();
  }
}
