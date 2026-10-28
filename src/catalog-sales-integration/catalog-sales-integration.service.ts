import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, Repository } from 'typeorm';
import { Producto } from '../producto/producto.entity';
import { VentaService } from '../venta/venta.service';
import { Card } from '../cards/card.entity';
import { User } from '../auth/entities/user.entity';
import { catalogSyncHeaders } from '../common/catalog-sync-auth';

const DEBIT_PAYMENT_OPTIONS = [
  { tipo: 'bcp' },
  { tipo: 'interbank' },
  { tipo: 'bbva' },
];

@Injectable()
export class CatalogSalesIntegrationService {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Producto) private readonly productoRepo: Repository<Producto>,
    @InjectRepository(Card) private readonly cardRepo: Repository<Card>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly ventaService: VentaService,
  ) {}

  private ownerFromSeller(value: unknown): 'gonzalo' | 'renato' | null {
    const seller = String(value || '').trim().toLowerCase();
    if (seller.includes('gonzalo')) return 'gonzalo';
    if (seller.includes('renato')) return 'renato';
    return null;
  }

  async paymentOptions(id: string) {
    const event = await this.getEvent(id);
    const codeMatch = String(event.sku || '').match(/(\d+)(?!.*\d)/);
    const code = Number(codeMatch?.[1]);
    const product = Number.isInteger(code) && code > 0
      ? await this.productoRepo.findOne({ where: [{ id: code }, { codigoInventario: code }] })
      : null;
    const sellerText = String(product?.vendedor || '').trim();
    const owners: Array<'gonzalo' | 'renato'> = sellerText.toLowerCase() === 'ambos'
      ? ['gonzalo', 'renato']
      : [this.ownerFromSeller(sellerText)].filter(Boolean) as Array<'gonzalo' | 'renato'>;
    if (!owners.length) return { owner: null, seller: product?.vendedor || null, cards: [] };
    for (const owner of owners) {
      let user = await this.userRepo.findOne({ where: { username: ILike(`%${owner}%`) } });
      if (!user && owner === 'gonzalo') user = await this.userRepo.findOne({ where: { role: 'admin' } });
      if (!user?.id) return { owner: null, seller: product?.vendedor || null, cards: [] };
    }
    return {
      owner: owners.length === 2 ? 'ambos' : owners[0],
      seller: product?.vendedor || null,
      // Los ingresos de ventas se registran como movimientos de debito.
      cards: DEBIT_PAYMENT_OPTIONS,
    };
  }

  async ensureTable() {
    if (!this.ready) {
      const schema = process.env.DB_SCHEMA || 'public';
      this.ready = (async () => {
        await this.dataSource.query(`CREATE TABLE IF NOT EXISTS "${schema}"."catalog_sale_events" (
          "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          "eventId" text NOT NULL UNIQUE,
          "catalogSaleId" text NOT NULL,
          "eventType" text NOT NULL,
          "sku" text NOT NULL,
          "title" text NULL,
          "amount" numeric(12,2) NOT NULL,
          "exchangeRate" numeric(10,4) NOT NULL,
          "soldAt" timestamptz NOT NULL,
          "status" text NOT NULL,
          "remoteVentaId" integer NULL,
          "payload" jsonb NOT NULL,
          "error" text NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          "confirmedAt" timestamptz NULL
        )`);
        await this.dataSource.query(
          `CREATE INDEX IF NOT EXISTS "idx_catalog_sale_events_status" ON "${schema}"."catalog_sale_events" ("status", "createdAt")`,
        );
      })().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async receive(eventId: string, payload: any) {
    await this.ensureTable();
    const eventType = String(payload?.eventType || '');
    if (!['sale.created', 'sale.cancelled', 'sale.updated'].includes(eventType)) {
      throw new BadRequestException('eventType invalido');
    }
    const catalogSaleId = String(payload?.catalogSaleId || '').trim();
    const sku = String(payload?.sku || '').trim();
    const amount = Number(payload?.amount);
    const exchangeRate = Number(payload?.exchangeRate);
    const soldAt = new Date(payload?.soldAt);
    if (!eventId || !catalogSaleId || !sku || !Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException('Datos de venta incompletos');
    }
    if (Number.isNaN(soldAt.getTime())) {
      throw new BadRequestException('Fecha invalida');
    }
    const schema = process.env.DB_SCHEMA || 'public';
    // El catálogo reutiliza el mismo eventId en cada edición de una venta, así
    // que la edición se aplica siempre en vez de tratarse como duplicado.
    if (eventType === 'sale.updated') {
      return this.applySaleUpdate(schema, eventId, payload, catalogSaleId, sku, amount, soldAt);
    }
    const existing = await this.dataSource.query(
      `SELECT * FROM "${schema}"."catalog_sale_events" WHERE "eventId" = $1 LIMIT 1`,
      [eventId],
    );
    if (existing[0]) {
      const stored = existing[0];
      // Reenvío de un alta aún sin confirmar: conserva el precio y la fecha más recientes.
      if (eventType === 'sale.created' && ['pending_confirmation', 'failed'].includes(stored.status)) {
        await this.dataSource.query(
          `UPDATE "${schema}"."catalog_sale_events"
              SET "amount" = $2, "soldAt" = $3, "payload" = $4::jsonb, "updatedAt" = now()
            WHERE "id" = $1`,
          [stored.id, amount, soldAt, JSON.stringify(payload)],
        );
        return { ok: true, status: stored.status, duplicate: true };
      }
      if (eventType === 'sale.created' && stored.status === 'rejected') {
        await this.dataSource.query(
          `UPDATE "${schema}"."catalog_sale_events"
              SET "status" = 'pending_confirmation', "error" = NULL,
                  "exchangeRate" = $2, "payload" = $3::jsonb, "amount" = $4, "soldAt" = $5,
                  "updatedAt" = now()
            WHERE "id" = $1`,
          [
            stored.id,
            Number.isFinite(exchangeRate) ? exchangeRate : Number(stored.exchangeRate || 0),
            JSON.stringify(payload),
            amount,
            soldAt,
          ],
        );
        return { ok: true, status: 'pending_confirmation', duplicate: true, reopened: true };
      }
      if (eventType === 'sale.created' && stored.status === 'confirmed') {
        const remoteSaleId = Number(stored.remoteVentaId);
        const remoteSale = Number.isInteger(remoteSaleId) && remoteSaleId > 0
          ? await this.dataSource.query(
              `SELECT 1 FROM "${schema}"."venta" WHERE "id" = $1 LIMIT 1`,
              [remoteSaleId],
            )
          : [];
        // Puede ocurrir si se confirmo una reventa antes que su anulacion
        // anterior: la anulacion borra luego la misma venta remota y deja el
        // evento nuevo marcado falsamente como confirmado.
        if (!remoteSale[0]) {
          await this.dataSource.query(
            `UPDATE "${schema}"."catalog_sale_events"
                SET "status" = 'pending_confirmation', "remoteVentaId" = NULL,
                    "error" = NULL, "confirmedAt" = NULL, "payload" = $2::jsonb,
                    "updatedAt" = now()
              WHERE "id" = $1`,
            [stored.id, JSON.stringify(payload)],
          );
          return { ok: true, status: 'pending_confirmation', duplicate: true, reopened: true };
        }
      }
      return { ok: true, status: stored.status, duplicate: true };
    }

    let remoteVentaId: number | null = null;
    let status = 'pending_confirmation';
    if (eventType === 'sale.cancelled') {
      const original = await this.dataSource.query(
        `SELECT "id", "status", "remoteVentaId" FROM "${schema}"."catalog_sale_events"
         WHERE "catalogSaleId" = $1 AND "eventType" = 'sale.created'
         ORDER BY "createdAt" DESC LIMIT 1`,
        [catalogSaleId],
      );
      remoteVentaId = original[0]?.remoteVentaId ? Number(original[0].remoteVentaId) : null;
      if (remoteVentaId) {
        status = 'pending_cancellation_confirmation';
      } else {
        status = 'cancelled_without_confirmation';
        if (original[0]?.id) {
          await this.dataSource.query(
            `UPDATE "${schema}"."catalog_sale_events"
             SET "status" = 'superseded_by_cancellation', "updatedAt" = now()
             WHERE "id" = $1`,
            [original[0].id],
          );
        }
      }
    }

    await this.dataSource.query(
      `INSERT INTO "${schema}"."catalog_sale_events"
       ("eventId", "catalogSaleId", "eventType", "sku", "title", "amount", "exchangeRate", "soldAt", "status", "remoteVentaId", "payload")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [eventId, catalogSaleId, eventType, sku, payload?.title || null, amount, Number.isFinite(exchangeRate) ? exchangeRate : 0, soldAt, status, remoteVentaId, JSON.stringify(payload)],
    );
    return { ok: true, status };
  }

  /**
   * Aplica una venta editada en el catálogo (precio o fecha):
   * - alta pendiente o rechazada: se corrigen sus datos para cuando se confirme;
   * - venta confirmada: se actualiza la venta real (recalcula ganancia e ingresos);
   * - venta anulada: no hay nada que actualizar.
   * Se guarda con estado propio (nunca pendiente) para que no aparezca en el
   * panel ni se confunda con una anulación al confirmar.
   */
  private async applySaleUpdate(
    schema: string,
    eventId: string,
    payload: any,
    catalogSaleId: string,
    sku: string,
    amount: number,
    soldAt: Date,
  ) {
    const original = (await this.dataSource.query(
      `SELECT "id", "status", "remoteVentaId", "payload" FROM "${schema}"."catalog_sale_events"
       WHERE "catalogSaleId" = $1 AND "eventType" = 'sale.created'
       ORDER BY "createdAt" DESC LIMIT 1`,
      [catalogSaleId],
    ))[0];
    // Sin alta todavía: el catálogo lo reintentará más tarde.
    if (!original) throw new NotFoundException('La venta aún no llegó a Servicios');

    const refreshOriginal = () => this.dataSource.query(
      `UPDATE "${schema}"."catalog_sale_events"
          SET "amount" = $2, "soldAt" = $3, "payload" = $4::jsonb, "updatedAt" = now()
        WHERE "id" = $1`,
      [original.id, amount, soldAt, JSON.stringify({ ...(original.payload || {}), amount, soldAt: soldAt.toISOString() })],
    );

    let status = 'update_ignored';
    let remoteVentaId: number | null = null;
    let error: string | null = null;
    if (['pending_confirmation', 'failed', 'rejected'].includes(original.status)) {
      await refreshOriginal();
      status = 'update_applied_to_pending';
    } else if (original.status === 'confirmed' && original.remoteVentaId) {
      remoteVentaId = Number(original.remoteVentaId);
      try {
        await this.ventaService.update(remoteVentaId, {
          precioVenta: amount,
          fechaVenta: soldAt.toISOString().slice(0, 10),
        } as any);
        await refreshOriginal();
        status = 'update_applied';
      } catch (err) {
        // Pagos combinados, adelantos o devoluciones: Servicios no lo cambia solo.
        error = err instanceof Error ? err.message : 'No se pudo actualizar la venta';
        status = 'update_failed';
      }
    }

    await this.dataSource.query(
      `INSERT INTO "${schema}"."catalog_sale_events"
       ("eventId", "catalogSaleId", "eventType", "sku", "title", "amount", "exchangeRate", "soldAt", "status", "remoteVentaId", "payload", "error")
       VALUES ($1,$2,'sale.updated',$3,$4,$5,0,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT ("eventId") DO UPDATE
       SET "amount" = EXCLUDED."amount", "soldAt" = EXCLUDED."soldAt", "status" = EXCLUDED."status",
           "remoteVentaId" = EXCLUDED."remoteVentaId", "payload" = EXCLUDED."payload",
           "error" = EXCLUDED."error", "updatedAt" = now()`,
      [eventId, catalogSaleId, sku, payload?.title || null, amount, soldAt, status, remoteVentaId, JSON.stringify(payload), error],
    );
    if (error) throw new BadRequestException(`No se pudo actualizar la venta en Servicios: ${error}`);
    return { ok: true, status };
  }

  async pending() {
    await this.ensureTable();
    const schema = process.env.DB_SCHEMA || 'public';
    // Las dos limpiezas solo cambian algo si hay cancelaciones esperando confirmación;
    // sin ellas se evita abrir una transacción de escritura en cada consulta del panel.
    const cancelacionesPendientes = await this.dataSource.query(
      `SELECT 1 FROM "${schema}"."catalog_sale_events"
       WHERE "eventType" = 'sale.cancelled' AND "status" = 'pending_cancellation_confirmation'
       LIMIT 1`,
    );
    if (cancelacionesPendientes.length) await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE "${schema}"."catalog_sale_events" original
         SET "status" = 'superseded_by_cancellation', "updatedAt" = now()
         WHERE original."eventType" = 'sale.created'
           AND original."remoteVentaId" IS NULL
           AND original."status" IN ('pending_confirmation', 'failed')
           AND EXISTS (
             SELECT 1 FROM "${schema}"."catalog_sale_events" cancellation
             WHERE cancellation."catalogSaleId" = original."catalogSaleId"
               AND cancellation."eventType" = 'sale.cancelled'
               AND cancellation."status" = 'pending_cancellation_confirmation'
           )`,
      );
      await manager.query(
        `UPDATE "${schema}"."catalog_sale_events" cancellation
         SET "status" = 'cancelled_without_confirmation', "updatedAt" = now()
         WHERE cancellation."eventType" = 'sale.cancelled'
           AND cancellation."status" = 'pending_cancellation_confirmation'
           AND NOT EXISTS (
             SELECT 1 FROM "${schema}"."catalog_sale_events" original
             WHERE original."catalogSaleId" = cancellation."catalogSaleId"
               AND original."eventType" = 'sale.created'
               AND original."remoteVentaId" IS NOT NULL
           )`,
      );
    });
    const events = await this.dataSource.query(
      `SELECT * FROM "${schema}"."catalog_sale_events"
       WHERE "status" IN ('pending_confirmation', 'pending_cancellation_confirmation', 'failed')
       ORDER BY "createdAt" DESC`,
    );
    return Promise.all(events.map(async (event: any) => {
      const codeMatch = String(event.sku || '').match(/(\d+)(?!.*\d)/);
      const code = Number(codeMatch?.[1]);
      if (!Number.isInteger(code) || code <= 0) return { ...event, costUsd: null };

      const product = await this.productoRepo.findOne({
        where: [{ id: code }, { codigoInventario: code }],
      });
      const costUsd = Number(product?.valor?.valorProducto);
      return {
        ...event,
        costUsd: Number.isFinite(costUsd) ? costUsd : null,
      };
    }));
  }

  private async getEvent(id: string) {
    await this.ensureTable();
    const schema = process.env.DB_SCHEMA || 'public';
    const rows = await this.dataSource.query(
      `SELECT * FROM "${schema}"."catalog_sale_events" WHERE "id" = $1 LIMIT 1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Evento no encontrado');
    return rows[0];
  }

  private async findPendingCancellationBefore(schema: string, event: any) {
    const rows = await this.dataSource.query(
      `SELECT "id", "remoteVentaId"
         FROM "${schema}"."catalog_sale_events"
        WHERE "eventType" = 'sale.cancelled'
          AND LOWER(TRIM("sku")) = LOWER(TRIM($1))
          AND "createdAt" < $2
          AND "status" IN ('pending_cancellation_confirmation', 'failed')
          AND "remoteVentaId" IS NOT NULL
        ORDER BY "createdAt" DESC
        LIMIT 1`,
      [event.sku, event.createdAt],
    );
    return rows[0] || null;
  }

  private async supersedePendingCancellationsBefore(schema: string, event: any) {
    await this.dataSource.query(
      `UPDATE "${schema}"."catalog_sale_events"
          SET "status" = 'superseded_by_resale', "error" = NULL, "updatedAt" = now()
        WHERE "eventType" = 'sale.cancelled'
          AND LOWER(TRIM("sku")) = LOWER(TRIM($1))
          AND "createdAt" < $2
          AND "status" IN ('pending_cancellation_confirmation', 'failed')`,
      [event.sku, event.createdAt],
    );
  }

  async confirm(id: string, submittedExchangeRate?: unknown, submittedIncomeBank?: unknown, submittedPaymentType?: unknown, submittedIncomeParts?: unknown) {
    const event = await this.getEvent(id);
    const schema = process.env.DB_SCHEMA || 'public';
    // Las ediciones se aplican al recibirse; confirmarlas caería en la rama de anulación.
    if (event.eventType === 'sale.updated') throw new BadRequestException('Las ediciones de venta no se confirman');
    if (['confirmed', 'cancelled'].includes(event.status)) {
      // Reintento: vuelve a avisar al catálogo por si el aviso anterior se perdió.
      await this.notifyCatalogStatus(String(event.eventId || ''), event.status);
      return event;
    }

    try {
      if (event.eventType === 'sale.created') {
        const enteredRate = Number(submittedExchangeRate);
        const storedRate = Number(event.exchangeRate);
        const exchangeRate = Number.isFinite(enteredRate) && enteredRate > 0
          ? enteredRate
          : Number.isFinite(storedRate) && storedRate > 0 ? storedRate : 3.7;
        const paymentType = submittedPaymentType == null ? undefined : String(submittedPaymentType);
        if (paymentType && !['direct', 'card', 'debt'].includes(paymentType)) {
          throw new BadRequestException('Selecciona directo, pago con tarjeta o deuda.');
        }
        const codeMatch = String(event.sku).match(/(\d+)(?!.*\d)/);
        const code = Number(codeMatch?.[1]);
        if (!Number.isInteger(code) || code <= 0) throw new BadRequestException(`SKU ${event.sku} no reconocido`);
        const product = await this.productoRepo.findOne({
          where: [{ id: code }, { codigoInventario: code }],
        });
        if (!product) throw new NotFoundException(`No existe el producto compartido ${event.sku}`);
        const paymentOptions = await this.paymentOptions(id);
        const incomeBank = String(submittedIncomeBank || '').trim();
        const parts = submittedIncomeParts as Array<{ type: string; amount: number }> | undefined;
        const cashOnly = Array.isArray(parts) && parts.length === 1 && parts[0]?.type === 'cash';
        if (!cashOnly && (!incomeBank || !paymentOptions.cards.some((card: any) => card.tipo === incomeBank))) {
          throw new BadRequestException('Selecciona una cuenta de débito disponible del vendedor');
        }
        const saleData: any = {
          productoId: product.id,
          tipoCambio: exchangeRate,
          fechaVenta: new Date(event.soldAt).toISOString().slice(0, 10),
          precioVenta: Number(event.amount),
          vendedor: product.vendedor || undefined,
          incomeBank,
          incomePaymentType: paymentType,
          incomeParts: parts,
          incomeSku: String(event.sku),
        };
        const pendingCancellation = await this.findPendingCancellationBefore(schema, event);
        let sale: any;
        if (pendingCancellation?.remoteVentaId) {
          try {
            sale = await this.ventaService.update(
              Number(pendingCancellation.remoteVentaId),
              saleData,
            );
          } catch (error) {
            // Si la anulacion alcanzo a borrar la venta pero no actualizo su
            // evento, recreamos la venta para dejar el estado final correcto.
            if (!(error instanceof NotFoundException)) throw error;
            sale = await this.ventaService.create(saleData);
          }
          await this.supersedePendingCancellationsBefore(schema, event);
        } else {
          sale = await this.ventaService.create(saleData);
        }
        await this.dataSource.query(
          `UPDATE "${schema}"."catalog_sale_events"
           SET "status" = 'confirmed', "remoteVentaId" = $2, "exchangeRate" = $3,
               "error" = NULL, "confirmedAt" = now(), "updatedAt" = now()
           WHERE "id" = $1`,
          [id, sale.id, exchangeRate],
        );
      } else {
        let ventaId = event.remoteVentaId ? Number(event.remoteVentaId) : null;
        let originalEvent: any = null;
        if (!ventaId) {
          const original = await this.dataSource.query(
            `SELECT "id", "status", "remoteVentaId" FROM "${schema}"."catalog_sale_events"
             WHERE "catalogSaleId" = $1 AND "eventType" = 'sale.created'
             ORDER BY "createdAt" DESC LIMIT 1`,
            [event.catalogSaleId],
          );
          originalEvent = original[0] || null;
          ventaId = originalEvent?.remoteVentaId ? Number(originalEvent.remoteVentaId) : null;
        }
        if (ventaId) {
          await this.ventaService.remove(ventaId, 'Cancelación solicitada desde el catálogo');
        } else if (originalEvent) {
          await this.dataSource.query(
            `UPDATE "${schema}"."catalog_sale_events"
             SET "status" = 'superseded_by_cancellation', "updatedAt" = now()
             WHERE "id" = $1`,
            [originalEvent.id],
          );
        }
        await this.dataSource.query(
          `UPDATE "${schema}"."catalog_sale_events"
           SET "status" = 'cancelled', "remoteVentaId" = $2, "error" = NULL, "confirmedAt" = now(), "updatedAt" = now()
           WHERE "id" = $1`,
          [id, ventaId],
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo confirmar';
      await this.dataSource.query(
        `UPDATE "${schema}"."catalog_sale_events" SET "status" = 'failed', "error" = $2, "updatedAt" = now() WHERE "id" = $1`,
        [id, message.slice(0, 1000)],
      );
      throw error;
    }
    const finalEvent = await this.getEvent(id);
    // Sin este aviso el catálogo seguía mostrando «Pendiente en Servicios».
    if (['confirmed', 'cancelled'].includes(finalEvent.status)) {
      await this.notifyCatalogStatus(String(finalEvent.eventId || ''), finalEvent.status);
    }
    return finalEvent;
  }

  /**
   * Reenvía al catálogo el estado final de los eventos ya resueltos (confirmados,
   * anulados o rechazados). Sirve para corregir ventas confirmadas antes de que
   * confirm() avisara. Es idempotente: el catálogo solo actualiza el estado.
   * Se ejecuta a mano con `npm run reconcile:catalog-sales` (no tiene ruta HTTP).
   * Se detiene tras varios fallos seguidos para no insistir si el catálogo no responde.
   */
  async reconcileCatalogStatuses(limit = 500, maxConsecutiveFailures = 5) {
    const schema = process.env.DB_SCHEMA || 'public';
    const max = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const events = await this.dataSource.query(
      `SELECT "eventId", "status" FROM "${schema}"."catalog_sale_events"
        WHERE "status" IN ('confirmed', 'cancelled', 'rejected') AND "eventId" IS NOT NULL
        ORDER BY "updatedAt" DESC LIMIT $1`,
      [max],
    );
    let notified = 0;
    let consecutiveFailures = 0;
    const failed: string[] = [];
    for (const event of events) {
      const ok = await this.notifyCatalogStatus(String(event.eventId || ''), String(event.status));
      if (ok) {
        notified += 1;
        consecutiveFailures = 0;
        continue;
      }
      failed.push(String(event.eventId));
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        return { ok: false, total: events.length, notified, failed, stoppedEarly: true };
      }
    }
    return { ok: failed.length === 0, total: events.length, notified, failed, stoppedEarly: false };
  }

  async setExchangeRate(id: string, submittedExchangeRate?: unknown) {
    const event = await this.getEvent(id);
    if (event.eventType !== 'sale.created') {
      throw new BadRequestException('El tipo de cambio solo corresponde a ventas');
    }
    const exchangeRate = Number(submittedExchangeRate);
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      throw new BadRequestException('Ingresa un tipo de cambio valido');
    }
    const schema = process.env.DB_SCHEMA || 'public';
    await this.dataSource.query(
      `UPDATE "${schema}"."catalog_sale_events"
          SET "exchangeRate" = $2, "payload" = $3::jsonb, "error" = NULL, "updatedAt" = now()
        WHERE "id" = $1`,
      [id, exchangeRate, JSON.stringify({ ...(event.payload || {}), exchangeRate })],
    );
    return { ok: true, status: event.status, exchangeRate };
  }

  private async notifyCatalogStatus(eventId: string, status: string) {
    const catalogSyncUrl = String(process.env.CATALOG_SYNC_URL || '').trim();
    if (!catalogSyncUrl || !eventId) return false;
    try {
      const url = new URL(catalogSyncUrl);
      url.pathname = '/admin/sales-sync/remote-status';
      url.search = '';
      url.hash = '';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-macso-event-id': eventId,
          ...catalogSyncHeaders(),
        },
        body: JSON.stringify({ status }),
        signal: AbortSignal.timeout(8000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async reject(id: string) {
    const event = await this.getEvent(id);
    if (event.eventType === 'sale.updated') throw new BadRequestException('Las ediciones de venta no se rechazan');
    const schema = process.env.DB_SCHEMA || 'public';
    await this.dataSource.query(
      `UPDATE "${schema}"."catalog_sale_events" SET "status" = 'rejected', "updatedAt" = now() WHERE "id" = $1`,
      [id],
    );
    await this.notifyCatalogStatus(String(event.eventId || ''), 'rejected');
    return { ok: true, status: 'rejected', eventType: event.eventType };
  }
}
