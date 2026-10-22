import { appCacheKey, invalidateProductos, registerCacheInvalidation } from './app-cache';

describe('cache compartida entre modulos', () => {
  it.each(['producto', 'venta', 'tracking', 'inventario', 'gastos', 'venta_pagos'])(
    'invalida listas, resumen y analytics al escribir %s', async (tableName) => {
      const cache: any = { del: jest.fn() };
      const ds: any = { subscribers: [] };
      const keys = ['productos:list:all', 'productos:resumen:2026', 'analytics:universe:v3']
        .map((key) => appCacheKey(cache, key));
      const subscriber = registerCacheInvalidation(ds, cache);
      await subscriber.afterUpdate!({ metadata: { tableName } } as any);
      keys.forEach((key) => expect(cache.del).toHaveBeenCalledWith(key));
      expect(appCacheKey(cache, 'productos:list:all')).not.toBe(keys[0]);
    },
  );
  it('no reutiliza resultados en vuelo iniciados antes de una escritura', async () => {
    const cache: any = { del: jest.fn() };
    const oldKey = appCacheKey(cache, 'productos:list:all');
    await invalidateProductos(cache);
    expect(appCacheKey(cache, 'productos:list:all')).not.toBe(oldKey);
  });
});
