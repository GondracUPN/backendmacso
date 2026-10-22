import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { DataSource, EntitySubscriberInterface } from 'typeorm';
import { catchError, concatMap, from, throwError } from 'rxjs';

const registries = new WeakMap<Cache, { generation: number; keys: Set<string> }>();
function registry(cache: Cache) {
  let value = registries.get(cache);
  if (!value) {
    value = { generation: 0, keys: new Set() };
    registries.set(cache, value);
  }
  return value;
}

/** La generacion impide reutilizar una lectura que termino despues de invalidar. */
export function appCacheKey(cache: Cache, key: string): string {
  const state = registry(cache);
  const versioned = `${key}:generation:${state.generation}`;
  state.keys.add(versioned);
  return versioned;
}

export async function invalidateProductos(cache: Cache): Promise<void> {
  const state = registry(cache);
  state.generation++;
  const keys = [...state.keys];
  state.keys.clear();
  // Una sola cache compartida. Borrado acotado, sin consultar la base.
  for (let i = 0; i < keys.length; i += 5) {
    await Promise.all(keys.slice(i, i + 5).map((key) => cache.del(key)));
  }
}
export const invalidateResumen = invalidateProductos;
export const invalidateAnalytics = invalidateProductos;

/** Cubre tambien escrituras internas, scripts y el commit de transacciones. */
export function registerCacheInvalidation(dataSource: DataSource, cache: Cache) {
  const invalidate = () => invalidateProductos(cache);
  const subscriber: EntitySubscriberInterface = {
    afterInsert: invalidate,
    afterUpdate: invalidate,
    afterRemove: invalidate,
    afterSoftRemove: invalidate,
    afterRecover: invalidate,
    afterTransactionCommit: invalidate,
  };
  dataSource.subscribers.push(subscriber);
  return subscriber;
}

@Injectable()
export class AppCacheInvalidator implements OnModuleInit {
  constructor(private readonly dataSource: DataSource, @Inject(CACHE_MANAGER) private readonly cache: Cache) {}
  onModuleInit() { registerCacheInvalidation(this.dataSource, this.cache); }
}

/** Incluye handlers que escriben mediante SQL directo y errores con cambios parciales. */
export class CacheInvalidationInterceptor implements NestInterceptor {
  constructor(private readonly cache: Cache) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const method = context.switchToHttp().getRequest().method;
    const path = context.switchToHttp().getRequest().path;
    if (method === 'POST' && ['/ventas/ultimas', '/ventas/adelantos/ultimos', '/ventas/adelantos/resumen'].includes(path)) return next.handle();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next.handle();
    return next.handle().pipe(
      concatMap(async (value) => { await invalidateProductos(this.cache); return value; }),
      catchError((error) => from(invalidateProductos(this.cache)).pipe(
        concatMap(() => throwError(() => error)),
      )),
    );
  }
}
