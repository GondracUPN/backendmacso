import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Producto } from './producto.entity';
import { ProductoDetalle } from './producto-detalle.entity';
import { ProductoValor } from './producto-valor.entity';
import { CreateProductoDto } from './dto/create-producto.dto';
import { UpdateProductoDto } from './dto/update-producto.dto';
import { Tracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';
import * as crypto from 'node:crypto';

function normalizeEstado(str?: string | null): string {
  if (!str) return '';
  const s = String(str).trim().toLowerCase();
  if (s.includes('camino')) return 'comprado_en_camino'; // ← clave base
  if (s === 'comprado_en_camino') return s; // ya normalizado
  return s;
}

@Injectable()
export class ProductoService {
  constructor(
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,

    @InjectRepository(ProductoDetalle)
    private readonly detalleRepo: Repository<ProductoDetalle>,

    @InjectRepository(ProductoValor)
    private readonly valorRepo: Repository<ProductoValor>,

    @InjectRepository(Tracking)
    private readonly trackingRepo: Repository<Tracking>,
    @InjectRepository(Venta)
    private readonly ventaRepo: Repository<Venta>,
  ) {}

  /** Crea un nuevo producto + detalle + valor + tracking inicial */
  async create(data: CreateProductoDto): Promise<Producto> {
    // 1) Guardar detalle
    let detalle: ProductoDetalle | null = null;
    if (data.detalle) {
      detalle = this.detalleRepo.create(data.detalle);
      detalle = await this.detalleRepo.save(detalle);
    }

    // 2) Guardar valor (con cálculos)
    let valor: ProductoValor | null = null;
    if (data.valor) {
      const { valorProducto, valorDec, peso, fechaCompra } = data.valor;
      const valorSoles = Number((valorProducto * 3.7).toFixed(2));
      const tarifaBase = this.getTarifa(peso);
      const hasta3kg = this.getTarifa(Math.min(peso, 3));
      let descuento = Number((hasta3kg * 0.35).toFixed(2));
      if (descuento > 41.99) descuento = 41.99;
      const tarifaFinal = Number((tarifaBase - descuento).toFixed(2));
      const honorarios = this.getHonorarios(valorDec);
      const seguro = this.getSeguro(valorDec);
      const costoEnvio = Number((tarifaFinal + honorarios + seguro).toFixed(2));
      const costoTotal = Number((valorSoles + costoEnvio).toFixed(2));

      valor = this.valorRepo.create({
        valorProducto,
        valorDec,
        peso,
        fechaCompra,
        valorSoles,
        costoEnvio,
        costoTotal,
      });
      valor = await this.valorRepo.save(valor);
    }

    // 3) Crear y guardar producto
    const producto = this.productoRepo.create({
      tipo: data.tipo,
      estado: data.estado,
      conCaja: data.conCaja ?? false,
      detalle: detalle || undefined,
      valor: valor || undefined,
    });
    const savedProducto = await this.productoRepo.save(producto);

    // 4) Crear tracking inicial: "Comprado (Sin Tracking)"
    await this.trackingRepo.save(
      this.trackingRepo.create({
        productoId: savedProducto.id,
        estado: 'comprado_sin_tracking',
      }),
    );

    // 5) Retornar producto con todas las relaciones (incluye tracking)
    return this.productoRepo.findOneOrFail({
      where: { id: savedProducto.id },
      relations: ['detalle', 'valor', 'tracking'],
    });
  }

  /** Devuelve todos los productos (opcionalmente filtrados por estatus) con sus relaciones */
  async findAll(estatus?: string): Promise<Producto[]> {
    const items = await this.productoRepo.find({
      relations: ['detalle', 'valor', 'tracking'],
      order: { id: 'DESC' },
    });

    if (!estatus) return items;

    const target = normalizeEstado(estatus);

    // Filtro en memoria por producto.estado o ÚLTIMO tracking.estado
    const result = items.filter((p) => {
      const eProd = normalizeEstado((p as any).estado || (p as any).status);
      if (eProd === target) return true;

      const trk = Array.isArray((p as any).tracking)
        ? [...(p as any).tracking]
        : [];
      if (!trk.length) return false;

      trk.sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        }
        return (b.id || 0) - (a.id || 0);
      });

      const last = trk[0];
      return normalizeEstado(last?.estado) === target;
    });

    return result;
  }

  /** Actualiza tipo, estado, conCaja, detalle y/o valor */
  async update(id: number, dto: UpdateProductoDto): Promise<Producto> {
    // 1) Cargar producto con relaciones
    const producto = await this.productoRepo.findOne({
      where: { id },
      relations: ['detalle', 'valor'],
    });
    if (!producto) {
      throw new NotFoundException(`Producto con id ${id} no encontrado`);
    }

    // 2) Actualizar campos principales si vienen
    if (dto.tipo !== undefined) producto.tipo = dto.tipo;
    if (dto.estado !== undefined) producto.estado = dto.estado;
    if (dto.conCaja !== undefined) producto.conCaja = dto.conCaja;
    await this.productoRepo.save(producto);

    // 3) Actualizar detalle
    if (dto.detalle && producto.detalle) {
      Object.assign(producto.detalle, dto.detalle);
      await this.detalleRepo.save(producto.detalle);
    }

    // 4) Actualizar valor + recálculos
    if (dto.valor && producto.valor) {
      const v = producto.valor;
      Object.assign(v, dto.valor);

      v.valorSoles = Number((v.valorProducto * 3.7).toFixed(2));
      const tarifaBase = this.getTarifa(v.peso);
      const hasta3kg = this.getTarifa(Math.min(v.peso, 3));
      let descuento = Number((hasta3kg * 0.35).toFixed(2));
      if (descuento > 41.99) descuento = 41.99;
      const tarifaFinal = Number((tarifaBase - descuento).toFixed(2));
      const honorarios = this.getHonorarios(v.valorDec);
      const seguro = this.getSeguro(v.valorDec);
      v.costoEnvio = Number((tarifaFinal + honorarios + seguro).toFixed(2));
      v.costoTotal = Number((v.valorSoles + v.costoEnvio).toFixed(2));

      await this.valorRepo.save(v);
    }

    // 5) Retornar entidad completa actualizada (incluye tracking)
    return this.productoRepo.findOneOrFail({
      where: { id },
      relations: ['detalle', 'valor', 'tracking'],
    });
  }

  /** Elimina un producto (y cascada en detalle/valor/tracking si está configurada) */
  async remove(id: number): Promise<void> {
    const producto = await this.productoRepo.findOne({
      where: { id },
      relations: ['detalle', 'valor', 'tracking'],
    });

    if (!producto) {
      throw new NotFoundException(`Producto con id ${id} no encontrado`);
    }

    await this.productoRepo.remove(producto);
  }

  // — Helpers para cálculos —
  private getTarifa(peso: number): number {
    const tabla: [number, number][] = [
      [0.5, 30.6],
      [1.0, 55],
      [1.5, 74],
      [2.0, 90],
      [2.5, 110],
      [3.0, 120],
      [3.5, 130],
      [4.0, 140],
      [4.5, 150],
      [5.0, 160],
      [5.5, 170],
      [6.0, 180],
      [6.5, 190],
      [7.0, 200],
      [7.5, 210],
      [8.0, 220],
      [8.5, 230],
      [9.0, 240],
      [9.5, 250],
      [10.0, 260],
    ];
    for (const [max, tarifa] of tabla) {
      if (peso <= max) return tarifa;
    }
    return tabla[tabla.length - 1][1];
  }

  private getHonorarios(fobUsd: number): number {
    if (fobUsd <= 100) return 16.3;
    if (fobUsd <= 200) return 25.28;
    if (fobUsd <= 1000) return 39.76;
    return 60.16;
  }

  private getSeguro(fobUsd: number): number {
    if (fobUsd <= 100) return 8.86;
    if (fobUsd <= 200) return 15.98;
    return 21.1;
  }

  // Nuevas utilidades para sincronizar con Catálogo
// Sincronización con Catálogo (métodos agregados al mismo servicio)
  // Determina si un producto está disponible: último tracking 'recogido' y sin ventas
  private async isDisponible(prod: any): Promise<boolean> {
    const ventas = await this.ventaRepo.count({ where: { productoId: prod.id } });
    if (ventas > 0) return false;
    const trk = Array.isArray(prod.tracking) ? [...prod.tracking] : [];
    if (!trk.length) return false;
    trk.sort((a, b) => {
      if (a.createdAt && b.createdAt) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return (b.id || 0) - (a.id || 0);
    });
    return (trk[0]?.estado || '').toLowerCase() === 'recogido';
  }

  private buildTitle(p: any): string {
    const tipo = (p.tipo || '').toString();
    const d = p.detalle || {};
    const modelo = (d.modelo || '').toString();
    const proc = (d.procesador || '').toString();
    const tam = (d.tamaño || d.tamanio || d.tamano || '').toString();
    return [tipo, modelo, proc, tam].filter(Boolean).join(' ').trim() || `Producto ${p.id}`;
  }

  private buildPayload(p: any) {
    const price = p?.valor?.costoTotal ?? p?.valor?.valorSoles ?? 0;
    // último tracking (si existe)
    const trk = Array.isArray(p.tracking) ? [...p.tracking] : [];
    trk.sort((a, b) => {
      if (a.createdAt && b.createdAt) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return (b.id || 0) - (a.id || 0);
    });
    const last = trk[0] || null;

    return {
      id: p.id,
      sku: `svc-${p.id}`,
      title: this.buildTitle(p),
      price: String(price ?? '0'),
      status: 'listed',
      stock: 1,
      // Enviamos especificaciones completas para que el catálogo pueda mostrarlas
      specs: {
        tipo: p.tipo ?? null,
        estado: p.estado ?? null,
        conCaja: p.conCaja ?? null,
        detalle: p.detalle ?? null,
        valor: p.valor ?? null,
        tracking_last: last,
      },
    };
  }

  private hmac(body: string, secret: string) {
    return crypto.createHmac('sha256', secret || '').update(body).digest('hex');
  }

  async syncDisponiblesConCatalogo() {
    const url = process.env.CATALOG_SYNC_URL;
    const secret = process.env.SYNC_SECRET || '';
    if (!url) {
      return { ok: false, message: 'CATALOG_SYNC_URL no configurado' };
    }
    const apiBase = (() => { try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return ''; } })();

    const prods = await this.productoRepo.find({
      relations: ['detalle', 'valor', 'tracking'],
      order: { id: 'DESC' },
    });

    let enviados = 0;
    const candidatos: number[] = [];
    const errores: Array<{ id: number; error: string }> = [];

    for (const p of prods) {
      try {
        if (!(await this.isDisponible(p))) continue;
        // Evitar duplicados consultando el catálogo por SKU
        const sku = `svc-${p.id}`;
        if (apiBase) {
          try {
            const r = await fetch(`${apiBase}/api/sync/exists?sku=${encodeURIComponent(sku)}`);
            const j = await r.json().catch(() => ({} as any));
            if (j && j.exists) continue;
          } catch {}
        }
        const payload = ((): any => {
          const price = p?.valor?.costoTotal ?? p?.valor?.valorSoles ?? 0;
          const d: any = (p as any).detalle || {};
          return {
            id: p.id,
            sku: `svc-${p.id}`,
            title: this.buildTitle(p),
            price: String(price ?? '0'),
            status: 'listed',
            stock: 1,
            specs: {
              tipo: p.tipo ?? null,
              estado: p.estado ?? null,
              conCaja: p.conCaja ?? null,
              detalle: {
                id: d?.id ?? null,
                gama: d?.gama ?? null,
                procesador: d?.procesador ?? null,
                generacion: d?.generacion ?? null,
                modelo: d?.modelo ?? null,
                ['tama��o']: d?.['tama��o'] ?? d?.tamanio ?? d?.tamano ?? null,
                almacenamiento: d?.almacenamiento ?? null,
                ram: d?.ram ?? null,
                conexion: d?.conexion ?? null,
                descripcionOtro: d?.descripcionOtro ?? null,
              },
              valor: { costoTotal: p?.valor?.costoTotal ?? null },
            },
          };
        })();
        candidatos.push(p.id);
        const body = JSON.stringify({ event: 'product.listed', product: payload });
        const signature = this.hmac(body, secret);
        const idem = crypto.randomUUID();

        await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-signature': signature,
            'x-idempotency-key': idem,
          },
          body,
        });
        enviados++;
      } catch (e: any) {
        errores.push({ id: (p as any).id, error: String(e?.message || e) });
      }
    }

    return { ok: true, total: candidatos.length, enviados, candidatos, errores };
  }
}
