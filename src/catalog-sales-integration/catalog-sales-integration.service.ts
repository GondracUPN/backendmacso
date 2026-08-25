import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Producto } from '../producto/producto.entity';
import { VentaService } from '../venta/venta.service';

@Injectable()
export class CatalogSalesIntegrationService {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Producto) private readonly productoRepo: Repository<Producto>,
    private readonly ventaService: VentaService,
  ) {}

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
    if (!['sale.created', 'sale.cancelled'].includes(eventType)) {
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
    if (eventType === 'sale.created' && (!Number.isFinite(exchangeRate) || exchangeRate <= 0)) {
      throw new BadRequestException('Tipo de cambio invalido');
    }

    const schema = process.env.DB_SCHEMA || 'public';
    const existing = await this.dataSource.query(
      `SELECT * FROM "${schema}"."catalog_sale_events" WHERE "eventId" = $1 LIMIT 1`,
      [eventId],
    );
    if (existing[0]) return { ok: true, status: existing[0].status, duplicate: true };

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

  async pending() {
    await this.ensureTable();
    const schema = process.env.DB_SCHEMA || 'public';
    await this.dataSource.transaction(async (manager) => {
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
    return this.dataSource.query(
      `SELECT * FROM "${schema}"."catalog_sale_events"
       WHERE "status" IN ('pending_confirmation', 'pending_cancellation_confirmation', 'failed')
       ORDER BY "createdAt" DESC`,
    );
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

  async confirm(id: string) {
    const event = await this.getEvent(id);
    const schema = process.env.DB_SCHEMA || 'public';
    if (['confirmed', 'cancelled'].includes(event.status)) return event;

    try {
      if (event.eventType === 'sale.created') {
        const codeMatch = String(event.sku).match(/(\d+)(?!.*\d)/);
        const code = Number(codeMatch?.[1]);
        if (!Number.isInteger(code) || code <= 0) throw new BadRequestException(`SKU ${event.sku} no reconocido`);
        const product = await this.productoRepo.findOne({
          where: [{ id: code }, { codigoInventario: code }],
        });
        if (!product) throw new NotFoundException(`No existe el producto compartido ${event.sku}`);
        const sale = await this.ventaService.create({
          productoId: product.id,
          tipoCambio: Number(event.exchangeRate),
          fechaVenta: new Date(event.soldAt).toISOString().slice(0, 10),
          precioVenta: Number(event.amount),
          vendedor: 'Catalogo',
        });
        await this.dataSource.query(
          `UPDATE "${schema}"."catalog_sale_events"
           SET "status" = 'confirmed', "remoteVentaId" = $2, "error" = NULL, "confirmedAt" = now(), "updatedAt" = now()
           WHERE "id" = $1`,
          [id, sale.id],
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
          await this.ventaService.remove(ventaId);
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
    return this.getEvent(id);
  }

  async reject(id: string) {
    const event = await this.getEvent(id);
    const schema = process.env.DB_SCHEMA || 'public';
    await this.dataSource.query(
      `UPDATE "${schema}"."catalog_sale_events" SET "status" = 'rejected', "updatedAt" = now() WHERE "id" = $1`,
      [id],
    );
    return { ok: true, status: 'rejected', eventType: event.eventType };
  }
}
