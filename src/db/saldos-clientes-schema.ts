import { QueryRunner } from 'typeorm';
/** Protecciones que TypeORM synchronize no representa. Idempotentes, sin reescribir dinero. */
export async function ensureSaldosClientesProtections(
  q: QueryRunner,
): Promise<void> {
  await q.query(`CREATE OR REPLACE FUNCTION proteger_pago_con_saldo() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF EXISTS(SELECT 1 FROM cliente_saldos WHERE pago_id=OLD.id) OR EXISTS(SELECT 1 FROM cliente_saldo_movimientos WHERE pago_id=OLD.id) THEN
          IF TG_OP='DELETE' THEN RAISE EXCEPTION 'El pago tiene saldo a favor vinculado'; END IF;
          IF (to_jsonb(OLD)-'saldo_convertido'-'updated_at') IS DISTINCT FROM (to_jsonb(NEW)-'saldo_convertido'-'updated_at')
             OR (OLD.saldo_convertido>0 AND NEW.saldo_convertido<>OLD.saldo_convertido) THEN
            RAISE EXCEPTION 'No se puede modificar el historial de un pago con saldo a favor';
          END IF;
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $body$`);
  await q.query(
    'DROP TRIGGER IF EXISTS proteger_pago_con_saldo ON venta_pagos',
  );
  await q.query(
    'CREATE OR REPLACE TRIGGER proteger_pago_con_saldo BEFORE UPDATE OR DELETE ON venta_pagos FOR EACH ROW EXECUTE FUNCTION proteger_pago_con_saldo()',
  );
  await q.query(`CREATE OR REPLACE FUNCTION proteger_ingreso_con_saldo() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF EXISTS(SELECT 1 FROM venta_pagos p JOIN cliente_saldos s ON s.pago_id=p.id WHERE p.gasto_id=OLD.id) THEN
          IF TG_OP='DELETE' THEN RAISE EXCEPTION 'El ingreso original respalda saldo de un cliente'; END IF;
          IF (to_jsonb(OLD)) IS DISTINCT FROM (to_jsonb(NEW)) THEN RAISE EXCEPTION 'El ingreso original respalda saldo de un cliente'; END IF;
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $body$`);
  await q.query('DROP TRIGGER IF EXISTS proteger_ingreso_con_saldo ON gastos');
  await q.query(
    'CREATE OR REPLACE TRIGGER proteger_ingreso_con_saldo BEFORE UPDATE OR DELETE ON gastos FOR EACH ROW EXECUTE FUNCTION proteger_ingreso_con_saldo()',
  );
  await q.query(`CREATE OR REPLACE FUNCTION proteger_devolucion_saldo() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF EXISTS(SELECT 1 FROM cliente_saldo_movimientos WHERE movimiento_id=OLD.id) THEN
          RAISE EXCEPTION 'La devolución está vinculada al historial del saldo del cliente';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $body$`);
  await q.query(
    'DROP TRIGGER IF EXISTS proteger_devolucion_saldo ON movimientos_financieros',
  );
  await q.query(
    'CREATE OR REPLACE TRIGGER proteger_devolucion_saldo BEFORE UPDATE OR DELETE ON movimientos_financieros FOR EACH ROW EXECUTE FUNCTION proteger_devolucion_saldo()',
  );
}
