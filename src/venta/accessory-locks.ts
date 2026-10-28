import { EntityManager } from 'typeorm';

/** Sales/imports share this lock; regrouping requires it exclusively before row locks. */
export function lockAccessoryTopology(manager: EntityManager, exclusive = false) {
  return manager.query(`SELECT pg_advisory_xact_lock${exclusive ? '' : '_shared'}(hashtext($1))`, ['accesorios:topologia']);
}
