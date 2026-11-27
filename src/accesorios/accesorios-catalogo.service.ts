import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, LessThan } from 'typeorm';
import { randomUUID } from 'crypto';
import { AccesoriosService } from './accesorios.service';
import { AccesorioCatalogo } from './accesorio-catalogo.entity';
import { Inventario } from '../inventario/inventario.entity';
import { operationHash } from '../venta/operation-hash';
import { accessoryOwner } from '../venta/accessory-quote';
import { catalogSyncHeaders } from '../common/catalog-sync-auth';
import { ProductoAccesoriosStock } from '../inventario/producto-accesorios-stock.entity';
import { accesorioParaCatalogo, lotesDeAccesoriosStock } from '../inventario/accesorios-stock';
import { accessoryUnitCost } from '../producto/accessory-cost';

function modelosParaCatalogo(
  lotes: { detalle?: { modelosCompatibles?: string[] } | null }[],
  compatibilidadReferencia?: string | null,
) {
  const modeloKey = (value: string) => value.toLowerCase();
  const referencia = compatibilidadReferencia?.trim() || '';
  const listas = lotes.map((lote) => new Map(
    (lote.detalle?.modelosCompatibles || []).map((modelo) => modelo.trim()).filter(Boolean)
      .map((modelo) => [modeloKey(modelo), modelo]),
  )).filter((lista) => lista.size > 0 && !(lista.size === 1 && lista.has(modeloKey(referencia))));
  if (!listas.length) return referencia ? [referencia] : [];
  const [primera, ...resto] = listas;
  // Una publicación agrupa los lotes bajo una sola ficha. Solo anuncia compatibilidades compartidas.
  return [...primera].filter(([key]) => resto.every((lista) => lista.has(key))).map(([, modelo]) => modelo);
}

@Injectable()
export class AccesoriosCatalogoService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | null = null;
  private readonly logger = new Logger(AccesoriosCatalogoService.name);
  constructor(private readonly ds: DataSource, private readonly accessories: AccesoriosService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    const run = () => {
      void this.synchronize().catch(() => this.logger.warn('No se pudo sincronizar accesorios; se reintentará.'));
      void this.sincronizarIncluidos().catch(() => this.logger.warn('No se pudieron sincronizar accesorios incluidos; se reintentará.'));
    };
    this.timer = setInterval(run, 30000);
    this.timer.unref();
    run();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async sincronizarIncluidos() {
    const url = process.env.CATALOG_SYNC_URL;
    if (!url) return;
    await this.ds.transaction(async (em) => {
      const [lock] = await em.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('accessory-includes-catalog-sync')) AS acquired",
      );
      if (!lock.acquired) return;
      const repo = em.getRepository(ProductoAccesoriosStock);
      const pendientes = await repo.createQueryBuilder('stock').innerJoin('stock.producto', 'p')
        .where('p."catalogoEnviado" = true')
        .andWhere('stock.revision > stock."revisionSincronizada"')
        .orderBy('stock.productoId', 'ASC').getMany();
      const lotes = await lotesDeAccesoriosStock(em, pendientes.flatMap((item) => item.accesorios));
      for (const stock of pendientes) {
        try {
          const response = await fetch(url, {
            method: 'POST', signal: AbortSignal.timeout(10000),
            headers: { 'Content-Type': 'application/json', 'x-idempotency-key': randomUUID(), ...catalogSyncHeaders() },
            body: JSON.stringify({
              event: 'product.accessories.updated',
              product: {
                sku: `svc-${stock.productoId}`,
                accesoriosStock: stock.accesorios.map((item) => accesorioParaCatalogo(item, lotes.get(item.productoId))),
                accesoriosStockRevision: stock.revision,
              },
            }),
          });
          const result = response.ok ? await response.json() : null;
          if (result?.productAccessoriesUpdated !== true || result.skipped === 'not_found') {
            throw new Error(`Catálogo HTTP ${response.status}`);
          }
          await repo.update({ productoId: stock.productoId, revisionSincronizada: LessThan(stock.revision) }, {
            revisionSincronizada: stock.revision,
          });
        } catch {
          this.logger.warn(`Accesorios incluidos pendientes de sincronización para svc-${stock.productoId}.`);
        }
      }
    });
  }

  private async groups() {
    const rows = await this.accessories.operativo(false);
    return rows.map((row) => {
      const owner = accessoryOwner(row.comprador);
      // El comprador delimita la asignación FIFO existente; nunca mezclar sus lotes.
      const esReferenciaLegada = row.referenciaId && !row.producto.empaqueAccesorio && !row.producto.fusionAccesorioId;
      const key = esReferenciaLegada ? `ref-${row.referenciaId}-${operationHash(owner).slice(0, 16)}`
        : `lot-${row.producto.fusionAccesorioId || Math.min(...row.lotes.map((lot) => lot.id))}`;
      const sku = `acc-${key}`;
      const faltantes: string[] = [];
      if (!row.nombre?.trim()) faltantes.push('nombre comercial');
      if (!owner) faltantes.push('comprador en la ficha de inventario');
      if (!(Number(row.precioPublicado) > 0)) faltantes.push('precio publicado mayor que cero');
      if (row.referencia?.activo === false) faltantes.push('referencia activa');
      const costo = row.costoProximaUnidad ?? accessoryUnitCost(row.producto);
      const costoCompraUnitario = costo == null ? null : +costo.toFixed(2);
      const payload = { id: sku, sku, title: row.nombre?.trim() || 'Accesorio', sourceTitle: row.nombre?.trim() || 'Accesorio', price: String(Number(row.precioPublicado) || 0), currency: 'PEN',
        legacySkus: row.lotes.map((lot) => `MS-${lot.id}`).sort(),
        stock: Math.max(0, row.disponible), selected: true,
        costoCompraUnitario,
        modelosCompatibles: modelosParaCatalogo(row.lotes, row.referencia?.compatibilidad),
        accessoryCode: row.codigo, productCondition: row.estado, category: 'accesorios', saleType: 'VENTA_SIMPLE',
        specs: { tipo: 'accesorios', estado: row.estado, detalle: { modelo: row.nombre, descripcionOtro: row.compatibilidad } } };
      return { key, row, payload, faltantes };
    });
  }

  async list() {
    const [groups, states] = await Promise.all([this.groups(), this.ds.getRepository(AccesorioCatalogo).find()]);
    return groups.map(({ key, row, faltantes }) => {
      const state = states.find((item) => item.key === key);
      return { key, nombre: row.nombre, comprador: row.comprador, disponible: row.disponible, productoId: row.producto.id,
        stockEnviado: state?.payload?.selected === true ? state.payload.stock : null,
        referenciaId: row.referenciaId, codigos: row.codigos, faltantes, seleccionado: state?.seleccionado ?? false,
        enviado: !!state?.payload?.selected && !!state?.syncHash, error: state?.error,
        sincronizadoAt: state?.sincronizadoAt };
    });
  }

  async select(keys: string[], selected: boolean) {
    await this.ds.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['accessory-catalog-sync']);
      const groups = await this.groups();
      const targets = [...new Set(keys)].map((key) => {
        const group = groups.find((item) => item.key === key);
        if (!group) throw new BadRequestException('El accesorio cambió. Actualiza la lista.');
        if (selected && !(Number(group.row.disponible) > 0)) throw new BadRequestException(`${group.row.nombre}: sin stock disponible para enviar al catálogo.`);
        if (selected && group.faltantes.length) throw new BadRequestException(`${group.row.nombre}: falta ${group.faltantes.join(', ')}. Completa su ficha de inventario o referencia.`);
        return group;
      });
      const repo = em.getRepository(AccesorioCatalogo);
      for (const group of targets) {
        const state = await repo.findOneBy({ key: group.key });
        await repo.save(repo.create({ ...state, key: group.key, seleccionado: selected }));
      }
    });
    await this.synchronize();
    return this.list();
  }

  async synchronize(forzarSeleccionados = false) {
    if (this.running) {
      if (!forzarSeleccionados) return;
      await this.running;
      return this.synchronize(true);
    }
    try {
      this.running = this.ds.transaction(async (em) => {
        await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['accessory-catalog-sync']);
        const repo = em.getRepository(AccesorioCatalogo);
        const states = await repo.find();
        const groups = await this.groups();
        // Retirar publicaciones antiguas por lote: la nueva regla exige selección explícita.
        for (const group of groups) {
          if (group.payload.legacySkus.length && !states.some((state) => state.key === group.key)) {
            const state = repo.create({ key: group.key, seleccionado: false });
            states.push(state); await repo.save(state);
          }
        }
        if (!states.length) return;
        const eventTable = await em.query("SELECT to_regclass('catalog_sale_events') AS name");
        const confirmed = eventTable[0]?.name ? await em.query(`SELECT sku, "catalogSaleId" FROM catalog_sale_events WHERE status = 'confirmed' AND "eventType" = 'sale.created' AND sku LIKE 'acc-%'`) : [];
        for (const state of states) {
          const group = groups.find((item) => item.key === state.key);
          // Sin datos válidos, retirar; conserva la selección para recuperar al corregir.
          const previouslySent = !!state.payload?.selected && !!state.syncHash;
          const hasStock = Number(group?.row.disponible) > 0;
          const selected = state.seleccionado && !!group && !group.faltantes.length && (hasStock || previouslySent);
          const base = selected ? group!.payload : state.payload || group?.payload;
          if (!base) continue;
          const payload = { ...base, selected, stock: selected ? base.stock : 0,
            confirmedSales: confirmed.filter((sale) => sale.sku === base.sku).map((sale) => String(sale.catalogSaleId)).sort() };
          // Las fotos se suben en el catálogo para aplicar su marca de agua.
          delete (payload as any).images;
          const hash = operationHash(payload);
          if (hash === state.syncHash && !(forzarSeleccionados && state.seleccionado)) continue;
          try {
            const url = process.env.CATALOG_SYNC_URL;
            if (!url) throw new Error('CATALOG_SYNC_URL no configurado.');
            const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000),
              headers: { 'Content-Type': 'application/json', 'x-idempotency-key': randomUUID(), ...catalogSyncHeaders() },
              body: JSON.stringify({ event: 'accessory.snapshot', product: payload }) });
            if (!response.ok) {
              // Muestra el motivo que devuelve el catálogo (p. ej. un error de base de datos) para diagnosticarlo.
              const body = await response.text().catch(() => '');
              let motivo = '';
              try { const parsed = JSON.parse(body); motivo = Array.isArray(parsed?.message) ? parsed.message.join(' | ') : String(parsed?.message || ''); } catch { motivo = body; }
              motivo = motivo.trim() && !/^internal server error$/i.test(motivo.trim()) ? `: ${motivo.trim().slice(0, 300)}` : '';
              throw new Error(`Catálogo HTTP ${response.status}${motivo || '.'}`);
            }
            const result = await response.json();
            if (result?.accessorySnapshot !== true) throw new Error('El receptor del catálogo necesita la actualización de accesorios.');
            state.payload = payload; state.syncHash = hash; state.sincronizadoAt = new Date();
            state.error = state.seleccionado && group?.faltantes.length ? `Falta ${group.faltantes.join(', ')}.`
              : state.seleccionado && group && !hasStock && !previouslySent ? 'Sin stock disponible para enviar al catálogo.' : null;
          } catch (error) { state.error = String(error.message || 'No se pudo sincronizar.'); }
          await repo.save(state);
        }
      });
      await this.running;
    } finally { this.running = null; }
  }

  async withdrawFromCatalog(sku: string) {
    if (!/^acc-(?:ref-\d+-[a-f0-9]{16}|lot-\d+)$/.test(sku)) throw new BadRequestException('SKU de accesorio inválido.');
    await this.ds.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['accessory-catalog-sync']);
      const repo = em.getRepository(AccesorioCatalogo);
      const state = await repo.findOneBy({ key: sku.slice(4) });
      if (!state) return;
      state.seleccionado = false;
      state.payload = state.payload ? { ...state.payload, selected: false, stock: 0 } : null;
      state.syncHash = state.payload ? operationHash(state.payload) : null;
      state.error = null;
      state.sincronizadoAt = new Date();
      await repo.save(state);
    });
    return { ok: true, seleccionado: false };
  }
}
