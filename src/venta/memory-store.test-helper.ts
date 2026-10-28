import { Venta } from './venta.entity';
import { VentaAdelanto } from './venta-adelanto.entity';
import { VentaDevolucion } from './venta-devolucion.entity';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { ProductoDetalle } from '../producto/producto-detalle.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { User } from '../auth/entities/user.entity';
import { VentaPago } from '../finanzas/entities/venta-pago.entity';
import { PagoLiquidacion } from '../finanzas/entities/pago-liquidacion.entity';
import { CuentaFinanciera } from '../finanzas/entities/cuenta-financiera.entity';
import { Reembolso } from '../finanzas/entities/reembolso.entity';
import { ReembolsoEvento } from '../finanzas/entities/reembolso-evento.entity';
import { Tracking } from '../tracking/tracking.entity';
import { Inventario } from '../inventario/inventario.entity';
import { AccesorioVinculoAuditoria, AccesorioVinculoPropuesta } from '../accesorios/accesorio-vinculo.entity';

/**
 * Almacén en memoria para pruebas unitarias: transacción simulada (un fallo restaura la
 * copia previa) y claves foráneas RESTRICT del esquema. Bloqueos y rollback reales en
 * PostgreSQL: test/finanzas.integration.e2e-spec.ts.
 */
type Tables = Map<any, any[]>;
const ENTITIES = [Venta, VentaAdelanto, VentaDevolucion, Producto, ProductoValor, ProductoDetalle, Gasto, User, VentaPago,
  PagoLiquidacion, CuentaFinanciera, Reembolso, ReembolsoEvento, Tracking, Inventario, AccesorioVinculoAuditoria, AccesorioVinculoPropuesta];

// [tabla hija, columna, tabla padre]: impiden borrar el padre mientras exista la hija.
const RESTRICT: Array<[any, string, any]> = [
  [Venta, 'productoId', Producto], [VentaDevolucion, 'ventaId', Venta], [Reembolso, 'productoId', Producto],
  [ReembolsoEvento, 'reembolsoId', Reembolso], [PagoLiquidacion, 'pagoId', VentaPago],
  [VentaAdelanto, 'productoId', Producto], [Tracking, 'productoId', Producto], [Inventario, 'productoId', Producto],
  [AccesorioVinculoAuditoria, 'productoId', Producto], [AccesorioVinculoPropuesta, 'productoId', Producto],
  [AccesorioVinculoAuditoria, 'loteId', AccesorioVinculoPropuesta], [AccesorioVinculoAuditoria, 'revierteAuditoriaId', AccesorioVinculoAuditoria],
  [Producto, 'valorId', ProductoValor], [Producto, 'detalleId', ProductoDetalle],
];

const matchValue = (actual: any, expected: any): boolean => {
  if (expected && typeof expected === 'object' && '_type' in expected) {
    const op = expected as any;
    if (op._type === 'isNull') return actual == null;
    if (op._type === 'in') return op._value.includes(actual);
    if (op._type === 'like') {
      const re = new RegExp(`^${String(op._value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
      return re.test(String(actual ?? ''));
    }
    if (op._type === 'not') return !matchValue(actual, op._value);
    throw new Error(`Operador no simulado ${op._type}`);
  }
  return actual === expected;
};
export const matches = (row: any, where: any): boolean => !where || (Array.isArray(where) ? where.some((w) => matches(row, w))
  : Object.entries(where).every(([key, value]) => matchValue(row[key], value)));

export function createStore(seed: Partial<Record<string, any[]>> = {}, options: { failOn?: string } = {}) {
  let tables: Tables = new Map(ENTITIES.map((entity) => [entity, (seed[entity.name] || []).map((row) => ({ ...row }))]));
  const writes: string[] = [];
  const t = (entity: any) => tables.get(entity)!;
  const nextId = (rows: any[]) => rows.reduce((max, row) => Math.max(max, row.id || 0), 0) + 1;
  const write = (op: string) => {
    writes.push(op);
    if (options.failOn === op) throw new Error(`fallo inyectado en ${op}`);
  };
  const withRelations = (entity: any, row: any, relations?: string[]) => {
    if (!row) return row;
    const copy = { ...row };
    if (entity === Venta && relations?.includes('producto')) copy.producto = { ...t(Producto).find((p) => p.id === row.productoId) };
    if (entity === VentaPago && relations?.includes('liquidaciones')) copy.liquidaciones = t(PagoLiquidacion).filter((l) => l.pagoId === row.id);
    if (entity === Producto && relations?.includes('valor')) copy.valor = t(ProductoValor).find((v) => v.id === row.valorId) || null;
    if (entity === Producto && relations?.includes('detalle')) copy.detalle = t(ProductoDetalle).find((v) => v.id === row.detalleId) || null;
    return copy;
  };
  const selected = (entity: any, criteria: any) => t(entity).filter((row) => typeof criteria === 'number' ? row.id === criteria
    : Array.isArray(criteria) ? criteria.includes(row.id) : matches(row, criteria));
  const repo = (entity: any) => ({
    find: async (opts: any = {}) => t(entity).filter((row) => matches(row, opts.where)).map((row) => withRelations(entity, row, opts.relations)),
    findBy: async (where: any) => t(entity).filter((row) => matches(row, where)).map((row) => ({ ...row })),
    findOne: async (opts: any = {}) => withRelations(entity, t(entity).find((row) => matches(row, opts.where)), opts.relations) || null,
    findOneBy: async (where: any) => { const row = t(entity).find((r) => matches(r, where)); return row ? { ...row } : null; },
    count: async (opts: any = {}) => t(entity).filter((row) => matches(row, opts.where)).length,
    create: (values: any) => ({ ...values }),
    save: async (value: any) => {
      write(`save:${entity.name}`);
      const rows = t(entity);
      const { producto, liquidaciones, valor, detalle, tracking, ...plain } = value;
      if (!plain.id) plain.id = nextId(rows);
      const index = rows.findIndex((row) => row.id === plain.id);
      if (index >= 0) rows[index] = { ...rows[index], ...plain }; else rows.push(plain);
      return { ...value, id: plain.id };
    },
    update: async (criteria: any, values: any) => {
      write(`update:${entity.name}`);
      selected(entity, criteria).forEach((row) => Object.assign(row, values));
    },
    insert: async (values: any) => { write(`insert:${entity.name}`); t(entity).push({ ...values, id: nextId(t(entity)) }); },
    delete: async (criteria: any) => {
      write(`delete:${entity.name}`);
      const ids = new Set(selected(entity, criteria).map((row) => row.id));
      for (const [child, column, parent] of RESTRICT) {
        if (parent !== entity) continue;
        const blocking = t(child).find((row) => ids.has(row[column]) && !(child === entity && ids.has(row.id)));
        if (blocking) throw new Error(`violación de clave foránea: ${child.name}.${column} -> ${entity.name}`);
      }
      tables.set(entity, t(entity).filter((row) => !ids.has(row.id)));
    },
    remove: async (values: any) => {
      write(`remove:${entity.name}`);
      const ids = new Set((Array.isArray(values) ? values : [values]).map((row) => row.id));
      tables.set(entity, t(entity).filter((row) => !ids.has(row.id)));
    },
  });
  // Solo las consultas SQL que usan los flujos probados; las de bloqueo no devuelven filas.
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    if (sql.includes('jsonb_array_elements')) {
      const id = Number(params[0]);
      return t(Venta).filter((v) => v.productoId !== id && (v.distribucionStock || []).some((x: any) => Number(x.productoId) === id))
        .map((v) => ({ id: v.id }));
    }
    if (sql.includes('FROM accesorio_vinculo_propuesta')) {
      const id = Number(params[0]);
      return t(AccesorioVinculoPropuesta).filter((p) => p.productoId === id || (p.productoIds || []).includes(id)).map((p) => ({ id: p.id }));
    }
    const count = sql.match(/count\(\*\)::int AS n FROM producto WHERE "(valorId|detalleId)" = \$1/);
    if (count) return [{ n: t(Producto).filter((p) => p[count[1]] === params[0]).length }];
    return [];
  });
  const manager: any = {
    getRepository: (entity: any) => repo(entity),
    query,
    transaction: async (run: any) => {
      const snapshot: Tables = new Map([...tables].map(([entity, rows]) => [entity, rows.map((row) => ({ ...row }))]));
      try { return await run(manager); } catch (error) { tables = snapshot; throw error; }
    },
  };
  return { manager, rows: (entity: any) => t(entity), writes };
}
