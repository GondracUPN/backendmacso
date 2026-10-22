import { MigrationInterface, QueryRunner } from 'typeorm';
import { migrationSchema } from '../common/migration-table';

/** Traslada los ajustes historicos de main.ts al despliegue, una sola vez. */
export class EsquemaLegacy1760831900000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    const schema = migrationSchema(qr);
    const sqlSchema = schema.replace(/"/g, '""');
      await qr.query(
        `CREATE TABLE IF NOT EXISTS "${sqlSchema}"."ebay_pawns" (
          "id" SERIAL PRIMARY KEY,
          "store_url" varchar(255) NOT NULL,
          "store_name" varchar(255) NOT NULL,
          "seller" varchar(120) NOT NULL,
          "original_url" varchar(255),
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."ebay_pawns" ADD COLUMN IF NOT EXISTS "original_url" varchar(255)`,
      );
      await qr.query(
        `CREATE INDEX IF NOT EXISTS "idx_ebay_pawns_store_url" ON "${sqlSchema}"."ebay_pawns" ("store_url")`,
      );
      await qr.query(
        `CREATE INDEX IF NOT EXISTS "idx_ebay_pawns_seller" ON "${sqlSchema}"."ebay_pawns" ("seller")`,
      );
      await qr.query(
        `CREATE TABLE IF NOT EXISTS "${sqlSchema}"."ebay_search_items" (
          "id" SERIAL PRIMARY KEY,
          "search_key" varchar(80) NOT NULL,
          "item_key" varchar(255) NOT NULL,
          "query" varchar(500) NOT NULL,
          "condition" varchar(40),
          "buying_options" varchar(80),
          "sort" varchar(40) NOT NULL,
          "pawn_only" boolean NOT NULL DEFAULT false,
          "ebay_offset" integer,
          "listed_at" TIMESTAMPTZ,
          "item" jsonb NOT NULL,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await qr.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_ebay_search_items_key_item" ON "${sqlSchema}"."ebay_search_items" ("search_key", "item_key")`,
      );
      await qr.query(
        `CREATE INDEX IF NOT EXISTS "idx_ebay_search_items_key_listed" ON "${sqlSchema}"."ebay_search_items" ("search_key", "listed_at" DESC)`,
      );
      await qr.query(
        `CREATE TABLE IF NOT EXISTS "${sqlSchema}"."ebay_search_state" (
          "id" SERIAL PRIMARY KEY,
          "search_key" varchar(80) NOT NULL,
          "next_ebay_offset" integer NOT NULL DEFAULT 0,
          "last_cache_total" integer NOT NULL DEFAULT 0,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await qr.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_ebay_search_state_key" ON "${sqlSchema}"."ebay_search_state" ("search_key")`,
      );
      await qr.query(
        `CREATE TABLE IF NOT EXISTS "${sqlSchema}"."ebay_viewed_items" (
          "id" SERIAL PRIMARY KEY,
          "item_key" varchar(255) NOT NULL,
          "item_url" varchar(1000),
          "title" varchar(500),
          "viewed_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await qr.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_ebay_viewed_items_key" ON "${sqlSchema}"."ebay_viewed_items" ("item_key")`,
      );
      await qr.query(
        `CREATE INDEX IF NOT EXISTS "idx_ebay_viewed_items_viewed_at" ON "${sqlSchema}"."ebay_viewed_items" ("viewed_at" DESC)`,
      );
      await qr.query(
        `CREATE TABLE IF NOT EXISTS "${sqlSchema}"."app_catalog_items" (
          "id" SERIAL PRIMARY KEY,
          "kind" varchar(40) NOT NULL,
          "productType" varchar(40),
          "family" varchar(80),
          "value" varchar(140) NOT NULL,
          "label" varchar(140) NOT NULL,
          "appliesDebit" boolean NOT NULL DEFAULT false,
          "appliesCredit" boolean NOT NULL DEFAULT false,
          "metadata" jsonb,
          "active" boolean NOT NULL DEFAULT true,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await qr.query(
        `CREATE INDEX IF NOT EXISTS "idx_app_catalog_kind_active" ON "${sqlSchema}"."app_catalog_items" ("kind", "active")`,
      );
      await qr.query(
        `CREATE TABLE IF NOT EXISTS "${sqlSchema}"."gastos_presupuestos" (
          "id" SERIAL PRIMARY KEY,
          "user_id" integer NOT NULL REFERENCES "${sqlSchema}"."users"("id") ON DELETE CASCADE,
          "month" varchar(7) NOT NULL,
          "amount" numeric(12,2) NOT NULL DEFAULT 0,
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await qr.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_gastos_presupuestos_user_month" ON "${sqlSchema}"."gastos_presupuestos" ("user_id", "month")`,
      );
      await qr.query(
        `CREATE INDEX IF NOT EXISTS "idx_gastos_presupuestos_month" ON "${sqlSchema}"."gastos_presupuestos" ("month")`,
      );
      await qr.query(
        `CREATE TABLE IF NOT EXISTS "${sqlSchema}"."bolsa_inversiones" (
          "id" SERIAL PRIMARY KEY,
          "user_id" integer NOT NULL REFERENCES "${sqlSchema}"."users"("id") ON DELETE CASCADE,
          "month" varchar(7) NOT NULL,
          "amount" numeric(12,2) NOT NULL,
          "date" date NOT NULL,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await qr.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_bolsa_inversiones_user_month" ON "${sqlSchema}"."bolsa_inversiones" ("user_id", "month")`,
      );
      await qr.query(
        `CREATE INDEX IF NOT EXISTS "idx_bolsa_inversiones_month" ON "${sqlSchema}"."bolsa_inversiones" ("month")`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."bolsa_inversiones" ADD COLUMN IF NOT EXISTS "hapi_amount" numeric(12,2) NOT NULL DEFAULT 0`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."bolsa_inversiones" ADD COLUMN IF NOT EXISTS "trii_amount" numeric(12,2) NOT NULL DEFAULT 0`,
      );
      await qr.query(
        `UPDATE "${sqlSchema}"."bolsa_inversiones"
         SET "hapi_amount" = ROUND("amount" * 0.70, 2),
             "trii_amount" = "amount" - ROUND("amount" * 0.70, 2)
         WHERE "amount" <> 0 AND "hapi_amount" = 0 AND "trii_amount" = 0`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ADD COLUMN IF NOT EXISTS accesorios text[] NOT NULL DEFAULT '{}'::text[]`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ADD COLUMN IF NOT EXISTS "stockInicial" integer NOT NULL DEFAULT 1`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ADD COLUMN IF NOT EXISTS "stockActual" integer NOT NULL DEFAULT 1`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ADD COLUMN IF NOT EXISTS "codigoInventario" integer`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ADD COLUMN IF NOT EXISTS "soloInventario" boolean NOT NULL DEFAULT false`,
      );
      // La versión anterior de "Agregar accesorio simple" creaba la compra
      // sin esta marca y con un tracking vacío. Recuperar esas compras antiguas
      // para que aparezcan solo en Inventario. La fecha fija evita reclasificar
      // accesorios normales que se creen después de esta corrección.
      const legacySimpleAccessories = await qr.query(
        `UPDATE "${sqlSchema}"."producto" p
         SET "soloInventario" = true
         FROM "${sqlSchema}"."producto_valor" v, "${sqlSchema}"."inventario" i
         WHERE p."valorId" = v.id
           AND i."productoId" = p.id
           AND LOWER(p.tipo) = 'accesorios'
           AND p."soloInventario" = false
           AND p.vendedor IS NULL
           AND p."envioGrupoId" IS NULL
           AND v."valorDec" = 0
           AND v.peso = 0
           AND i."enAlmacen" = true
           AND i."createdAt" < TIMESTAMPTZ '2026-10-06 05:00:00+00'
           AND v."fechaCompra"::date IN (
             i."createdAt"::date,
             (i."createdAt" AT TIME ZONE 'America/Lima')::date
           )
           AND EXISTS (
             SELECT 1 FROM "${sqlSchema}"."tracking" t
             WHERE t."productoId" = p.id
               AND t.estado = 'comprado_sin_tracking'
               AND t.tracking_usa IS NULL AND t.tracking_eshop IS NULL AND t.casillero IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM "${sqlSchema}"."tracking" t
             WHERE t."productoId" = p.id
               AND (t.estado <> 'comprado_sin_tracking'
                 OR t.tracking_usa IS NOT NULL OR t.tracking_eshop IS NOT NULL OR t.casillero IS NOT NULL)
           )
         RETURNING p.id`,
      );
      if (legacySimpleAccessories.length) {
        console.log('[BOOT][LEGACY_SIMPLE_ACCESSORIES]', legacySimpleAccessories.map((row: { id: number }) => row.id));
      }
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "cantidad_500" integer`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "destinatario_500" varchar(12)`,
      );
      await qr.query(`ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "sale_id" integer`);
      await qr.query(`ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "sale_sku" varchar(100)`);
      await qr.query(`ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "sale_payment_type" varchar(12)`);
      await qr.query(`ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "sale_received_amount" numeric(12,2)`);
      await qr.query(`ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "sale_paid_at" date`);
      await qr.query(`ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "sale_payment_history" jsonb`);
      await qr.query(`ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "sale_exchange_rate" numeric(10,4)`);
      await qr.query(`ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "ciclo_override" varchar(7)`);
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."gastos" ADD COLUMN IF NOT EXISTS "itf_ingreso_id" integer`,
      );
      await qr.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_gastos_itf_ingreso" ON "${sqlSchema}"."gastos" ("itf_ingreso_id") WHERE "itf_ingreso_id" IS NOT NULL`,
      );
      await qr.query(
        `CREATE INDEX IF NOT EXISTS "idx_producto_codigo_inventario" ON "${sqlSchema}"."producto" ("codigoInventario")`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto_detalle" ADD COLUMN IF NOT EXISTS "modelosCompatibles" text[] NOT NULL DEFAULT '{}'::text[]`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto_valor" ADD COLUMN IF NOT EXISTS "monedaCompra" varchar(3) NOT NULL DEFAULT 'USD'`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ADD COLUMN IF NOT EXISTS vendedor varchar(80)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ADD COLUMN IF NOT EXISTS "catalogoEnviado" boolean NOT NULL DEFAULT false`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ADD COLUMN IF NOT EXISTS "catalogoEnviadoAt" TIMESTAMPTZ`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ADD COLUMN IF NOT EXISTS "despachoCasillero" boolean NOT NULL DEFAULT false`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ADD COLUMN IF NOT EXISTS "despachoCasilleroAt" TIMESTAMPTZ`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."personal_eshopex" ADD COLUMN IF NOT EXISTS "costoEnvio" numeric(10,2) NOT NULL DEFAULT 0`,
      );
      await qr.query(
        `CREATE TABLE IF NOT EXISTS "${sqlSchema}"."inventario" (
          "id" SERIAL PRIMARY KEY,
          "productoId" integer NOT NULL REFERENCES "${sqlSchema}"."producto"("id") ON DELETE CASCADE,
          "enAlmacen" boolean NOT NULL DEFAULT false,
          "color" varchar(80),
          "ciclosBateria" integer,
          "saludBateria" integer,
          "primerPrecioSoles" numeric(12,2),
          "ultimoPrecioSoles" numeric(12,2),
          "garantiaHasta" date,
          "tieneGarantia" boolean NOT NULL DEFAULT false,
          "tipoGarantia" varchar(30),
          "garantiaDetalle" varchar(180),
          "serial" varchar(120),
          "imei" varchar(40),
          "imei2" varchar(40),
          "accesorios" text[] NOT NULL DEFAULT '{}'::text[],
          "observaciones" text,
          "fotoUrl" varchar(600),
          "fotoPublicId" varchar(240),
          "fotosTomadas" boolean NOT NULL DEFAULT false,
          "marketplaceSubido" boolean NOT NULL DEFAULT false,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await qr.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_inventario_producto" ON "${sqlSchema}"."inventario" ("productoId")`,
      );
      await qr.query(
        `CREATE TABLE IF NOT EXISTS "${sqlSchema}"."sickw_check_history" (
          "id" SERIAL PRIMARY KEY,
          "service_id" varchar(32) NOT NULL,
          "service_name" varchar(120) NOT NULL,
          "cost_usd" numeric(10,3) NOT NULL DEFAULT 0,
          "identifier" varchar(32) NOT NULL,
          "type" varchar(12),
          "serial" varchar(32),
          "imei" varchar(20),
          "imei2" varchar(20),
          "fields" jsonb NOT NULL DEFAULT '[]'::jsonb,
          "raw" text,
          "results" jsonb,
          "checked_at" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await qr.query(
        `CREATE INDEX IF NOT EXISTS "idx_sickw_history_identifier_service" ON "${sqlSchema}"."sickw_check_history" ("identifier", "service_id")`,
      );
      await qr.query(
        `CREATE INDEX IF NOT EXISTS "idx_sickw_history_checked_at" ON "${sqlSchema}"."sickw_check_history" ("checked_at" DESC)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."inventario" ADD COLUMN IF NOT EXISTS "imei2" varchar(40)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."inventario" ADD COLUMN IF NOT EXISTS "primerPrecioSoles" numeric(12,2)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."inventario" ADD COLUMN IF NOT EXISTS "ultimoPrecioSoles" numeric(12,2)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."inventario" ADD COLUMN IF NOT EXISTS "tieneGarantia" boolean NOT NULL DEFAULT false`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."inventario" ADD COLUMN IF NOT EXISTS "tipoGarantia" varchar(30)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto" ALTER COLUMN vendedor TYPE varchar(80)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."venta" ADD COLUMN IF NOT EXISTS vendedor varchar(80)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."venta" ALTER COLUMN vendedor TYPE varchar(80)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."tracking" ADD COLUMN IF NOT EXISTS estatus_esho varchar`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."tracking" ADD COLUMN IF NOT EXISTS "contabilizadoAt" TIMESTAMPTZ`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."producto_detalle" ADD COLUMN IF NOT EXISTS esim varchar`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."venta" ADD COLUMN IF NOT EXISTS "tipoCambioGonzalo" numeric(10,4)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."venta" ADD COLUMN IF NOT EXISTS "tipoCambioRenato" numeric(10,4)`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."venta" ADD COLUMN IF NOT EXISTS "cantidad" integer NOT NULL DEFAULT 1`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."venta" ADD COLUMN IF NOT EXISTS "modalidad" varchar(20) NOT NULL DEFAULT 'unidad'`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."venta" ADD COLUMN IF NOT EXISTS "distribucionStock" jsonb`,
      );
      await qr.query(
        `ALTER TABLE "${sqlSchema}"."venta_adelanto" ADD COLUMN IF NOT EXISTS "cuotas" jsonb NOT NULL DEFAULT '[]'::jsonb`,
      );
      await qr.query(
        `CREATE TABLE IF NOT EXISTS "${sqlSchema}"."personal_eshopex" (
          "id" SERIAL PRIMARY KEY,
          "trackingEshop" varchar(80) NOT NULL,
          "descripcion" text NOT NULL DEFAULT 'Personal',
          "peso" numeric(10,2),
          "valorDec" numeric(10,2) NOT NULL DEFAULT 0,
          "estatusEsho" varchar(120),
          "fechaRecepcion" date,
          "fechaRecepcionRaw" varchar(40),
          "casillero" varchar(80),
          "account" varchar(160),
          "despacho" boolean NOT NULL DEFAULT false,
          "despachoAt" TIMESTAMPTZ,
          "recogido" boolean NOT NULL DEFAULT false,
          "fechaRecogido" date,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await qr.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_personal_eshopex_tracking" ON "${sqlSchema}"."personal_eshopex" ("trackingEshop")`,
      );

      const renameCandidates = await qr.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'producto_detalle'`,
        [schema],
      );
      const hasTamano = renameCandidates.some((r: any) => r.column_name === 'tamano');
      const hasTamanio = renameCandidates.some((r: any) => r.column_name === 'tama\u00f1o');
      if (!hasTamano && hasTamanio) {
        await qr.query(
          `ALTER TABLE "${sqlSchema}"."producto_detalle" RENAME COLUMN "tama\u00f1o" TO tamano`,
        );
      }

  }
  async down(): Promise<void> {
    // Los ajustes historicos y sus datos se conservan al revertir el despliegue.
  }
}
