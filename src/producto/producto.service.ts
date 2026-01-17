import { Injectable, NotFoundException, Inject, BadRequestException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Cache } from 'cache-manager';
import { Producto } from './producto.entity';
import { ProductoDetalle } from './producto-detalle.entity';
import { ProductoValor } from './producto-valor.entity';
import { CreateProductoDto } from './dto/create-producto.dto';
import { UpdateProductoDto } from './dto/update-producto.dto';
import { Tracking, EstadoTracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';
import * as crypto from 'node:crypto';

function normalizeEstado(str?: string | null): string {
  if (!str) return '';
  const s = String(str).trim().toLowerCase();
  if (s.includes('camino')) return 'comprado_en_camino'; // â clave base
  if (s === 'comprado_en_camino') return s; // ya normalizado
  return s;
}

@Injectable()
export class ProductoService {
  // Cache corto para listados (mitiga lecturas repetidas en red/DB lenta)
  private readonly listCacheKeys = new Set<string>();
  private readonly listCacheTtlSeconds = 30;

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
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  private buildListCacheKey(estatus?: string | null): string {
    const normalized = normalizeEstado(estatus);
    return `productos:list:${normalized || 'all'}`;
  }

  private async invalidateListCache(): Promise<void> {
    const keys = Array.from(this.listCacheKeys.values());
    this.listCacheKeys.clear();
    await Promise.all(
      keys.map((k) => this.cache.del(k).catch(() => undefined)),
    );
  }

  /** Crea un nuevo producto + detalle + valor + tracking inicial */
  async create(data: CreateProductoDto): Promise<Producto> {
    // 1) Guardar detalle
    let detalle: ProductoDetalle | null = null;
    if (data.detalle) {
      // Normalizar variantes hacia la clave estándar ASCII 'tamano'
      const raw: any = { ...(data.detalle as any) };
      raw.tamano = raw.tamano ?? raw.tamanio ?? raw['tama\u00f1o'] ?? null;
      delete raw.tamanio;
      delete raw['tama\u00f1o'];
      detalle = this.detalleRepo.create(raw as any) as unknown as ProductoDetalle;
      detalle = (await this.detalleRepo.save(detalle as any)) as ProductoDetalle;
    }

    // 2) Guardar valor (con cÃ¡lculos)
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

    // 3) Vinculación opcional para prorratear envío
    let envioGrupoId: string | null = null;
    if ((data as any).vincularCon) {
      envioGrupoId = await this.ensureEnvioGrupo((data as any).vincularCon, undefined, null);
    }

    // 4) Crear y guardar producto
    // Normalizar accesorios según reglas de negocio
    let accesorios: string[] = Array.isArray((data as any).accesorios)
      ? ((data as any).accesorios as string[])
      : [];
    const accNorm = (s: string) => s?.toString().trim().toLowerCase();
    if (accesorios.map(accNorm).includes('todos')) accesorios = ['Caja', 'Cubo', 'Cable'];
    if ((data.estado || '').toLowerCase() === 'nuevo') { accesorios = ['Caja','Cubo','Cable']; }

    const producto = this.productoRepo.create({
      tipo: data.tipo,
      estado: data.estado,
      accesorios,
      envioGrupoId: envioGrupoId || null,
      detalle: detalle || undefined,
      valor: valor || undefined,
      facturaDecSubida: !!data.facturaDecSubida,
    });
    const savedProducto = await this.productoRepo.save(producto);

    // 5) Prorratear envío si corresponde
    if (envioGrupoId && valor) {
      await this.recalcEnvioGrupo(envioGrupoId);
    } else if (valor) {
      valor.costoEnvioProrrateado = valor.costoEnvio;
      valor.costoTotalProrrateado = valor.costoTotal;
      await this.valorRepo.save(valor);
    }

    // 6) Crear tracking inicial: "Comprado (Sin Tracking)"
    await this.trackingRepo.save(
      this.trackingRepo.create({
        productoId: savedProducto.id,
        estado: 'comprado_sin_tracking',
      }),
    );
    if (envioGrupoId) {
      await this.syncTrackingEnGrupo(envioGrupoId);
    }

    // 5) Retornar producto con todas las relaciones (incluye tracking)
    const finalProd = await this.productoRepo.findOneOrFail({
      where: { id: savedProducto.id },
      relations: ['detalle', 'valor', 'tracking'],
    });
    await this.invalidateListCache();
    return this.applyProrrateadoView(finalProd);
  }

  /** Devuelve todos los productos (opcionalmente filtrados por estatus) con sus relaciones */
  async findAll(estatus?: string): Promise<Producto[]> {
    const cacheKey = this.buildListCacheKey(estatus);
    const cached = await this.cache.get<Producto[]>(cacheKey);
    if (cached !== undefined && cached !== null) return cached;
    // Usar QueryBuilder con columnas explícitas para evitar problemas con nombres acentuados
    const qb = this.productoRepo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.detalle', 'd')
      .leftJoinAndSelect('p.valor', 'v')
      .leftJoinAndSelect('p.tracking', 't')
      .orderBy('p.id', 'DESC');

    let items: Producto[] = [];
    try {
      items = await qb.getMany();
    } catch (e: any) {
      console.error('[ProductoService.findAll] DB error:', e && e.stack ? e.stack : e);
      throw e;
    }

    // Normalizar detalle y accesorios antes de retornar
    items = items.map((p) => {
      const prod = { ...p } as any;
      const det: any = prod.detalle || {};
      // Asegura clave ASCII 'tamano' (no mueve el valor en DB, solo en la respuesta)
      const tam = det.tamano ?? det.tamanio ?? det['tamaño'];
      if (tam !== undefined) {
        det.tamano = tam;
        delete det.tamanio;
        delete det['tamaño'];
      }
      prod.detalle = det;
      // Asegura accesorios como arreglo (no los borra)
      if (!Array.isArray(prod.accesorios)) prod.accesorios = [];
      return this.applyProrrateadoView(prod as Producto);
    });

    if (!estatus) {
      await this.cache.set(cacheKey, items, this.listCacheTtlSeconds);
      this.listCacheKeys.add(cacheKey);
      return items;
    }

    const target = normalizeEstado(estatus);

    // Filtro en memoria por producto.estado o ÃLTIMO tracking.estado
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

    await this.cache.set(cacheKey, result, this.listCacheTtlSeconds);
    this.listCacheKeys.add(cacheKey);
    return result;
  }

  private applyProrrateadoView(p: Producto): Producto {
    if (p?.valor && p.valor.costoEnvioProrrateado != null) {
      const v: any = { ...p.valor };
      const envio = Number(p.valor.costoEnvioProrrateado);
      const baseSoles = Number(v.valorSoles ?? v.valorProducto * 3.7 ?? 0);
      v.costoEnvio = envio;
      v.costoTotal = Number((baseSoles + envio).toFixed(2));
      p.valor = v;
    }
    return p;
  }

  /** Actualiza tipo, estado, accesorios, detalle y/o valor */
  async update(id: number, dto: UpdateProductoDto): Promise<Producto> {
    // 1) Cargar producto con relaciones
    const producto = await this.productoRepo.findOne({
      where: { id },
      relations: ['detalle', 'valor', 'tracking'],
    });
    if (!producto) {
      throw new NotFoundException(`Producto con id ${id} no encontrado`);
    }

    let envioGrupoId: string | null = producto.envioGrupoId ?? null;
    const oldEnvioGrupo = producto.envioGrupoId || null;
    if ((dto as any).vincularCon) {
      const cas = this.getCasillero(producto);
      envioGrupoId = await this.ensureEnvioGrupo((dto as any).vincularCon, cas, oldEnvioGrupo);
      producto.envioGrupoId = envioGrupoId;
    }
    if ((dto as any).desvincularEnvio) {
      producto.envioGrupoId = null;
      envioGrupoId = null;
    }
    const justLinkedToGroup = !!envioGrupoId && envioGrupoId !== oldEnvioGrupo;

    // 2) Actualizar campos principales si vienen
    if (dto.tipo !== undefined) producto.tipo = dto.tipo;
    if (dto.estado !== undefined) producto.estado = dto.estado;
    if (dto.facturaDecSubida !== undefined) {
      producto.facturaDecSubida = !!dto.facturaDecSubida;
    }
    
    await this.productoRepo.save(producto);

    // Accesorios: si vienen en el DTO, normalizarlos y actualizar
    if ((dto as any).accesorios !== undefined) {
      let acc: string[] = Array.isArray((dto as any).accesorios) ? ((dto as any).accesorios as string[]) : [];
      const accNorm = (s: string) => s?.toString().trim().toLowerCase();
      if (acc.map(accNorm).includes('todos')) acc = ['Caja', 'Cubo', 'Cable'];
      if ((producto.estado || '').toLowerCase() === 'nuevo' && !acc.includes('Caja')) acc.push('Caja');
      producto.accesorios = acc;
      await this.productoRepo.save(producto);
      // accesorios ya normalizados arriba
    } else if (dto.estado !== undefined && (dto.estado || '').toLowerCase() === 'nuevo') {
      const set = new Set<string>(producto.accesorios || []);
      set.add('Caja');
      producto.accesorios = Array.from(set);
      // estado nuevo: accesorios ya forzados con Caja; agrega si faltaba
      await this.productoRepo.save(producto)
    }
    // Enforce 'Todos' cuando el estado es 'nuevo'
    if ((producto.estado || '').toLowerCase() === 'nuevo') {
      producto.accesorios = ['Caja','Cubo','Cable'];
      await this.productoRepo.save(producto);
    }

    // 3) Actualizar detalle
    if (dto.detalle && producto.detalle) {
      const d: any = { ...dto.detalle };
      // Normalizar variantes de tamaño hacia 'tamano' (ASCII)
      const nuevoTam = d.tamano ?? d.tamanio ?? d['tama\u00f1o'];
      if (nuevoTam !== undefined) {
        d.tamano = nuevoTam;
        delete d.tamanio;
        delete d['tama\u00f1o'];
      }
      Object.assign(producto.detalle, d);
      await this.detalleRepo.save(producto.detalle);
    }

    // 4) Actualizar valor + recÃ¡lculos
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

    // Si está en grupo y se modificó peso o valorDec, sincroniza a todos
    if (envioGrupoId && dto.valor && (dto.valor.peso !== undefined || dto.valor.valorDec !== undefined)) {
      const pesoRefNum =
        dto.valor.peso !== undefined ? Number(dto.valor.peso) : undefined;
      const decRefNum =
        dto.valor.valorDec !== undefined ? Number(dto.valor.valorDec) : undefined;
      if (pesoRefNum !== undefined && (!Number.isFinite(pesoRefNum) || pesoRefNum <= 0)) {
        throw new BadRequestException('Peso inválido para sincronizar en grupo');
      }
      if (decRefNum !== undefined && !Number.isFinite(decRefNum)) {
        throw new BadRequestException('Valor DEC inválido para sincronizar en grupo');
      }

      const peers = await this.productoRepo.find({
        where: { envioGrupoId },
        relations: ['valor'],
      });
      for (const peer of peers) {
        if (!peer.valor) continue;
        if (pesoRefNum !== undefined) peer.valor.peso = pesoRefNum;
        if (decRefNum !== undefined) peer.valor.valorDec = decRefNum;
        peer.valor.valorSoles = Number((Number(peer.valor.valorProducto) * 3.7).toFixed(2));
        peer.valor.costoEnvio = (() => {
          const pesoCalc = Number(peer.valor.peso);
          const tarifaBase = this.getTarifa(pesoCalc);
          const hasta3kg = this.getTarifa(Math.min(pesoCalc, 3));
          let descuento = Number((hasta3kg * 0.35).toFixed(2));
          if (descuento > 41.99) descuento = 41.99;
          const tarifaFinal = Number((tarifaBase - descuento).toFixed(2));
          const honorarios = this.getHonorarios(Number(peer.valor.valorDec));
          const seguro = this.getSeguro(Number(peer.valor.valorDec));
          return Number((tarifaFinal + honorarios + seguro).toFixed(2));
        })();
        const baseSoles = Number(peer.valor.valorSoles ?? peer.valor.valorProducto * 3.7 ?? 0);
        peer.valor.costoTotal = Number((baseSoles + (peer.valor.costoEnvio || 0)).toFixed(2));
        await this.valorRepo.save(peer.valor);
      }
    }

    if (producto.envioGrupoId) {
      await this.recalcEnvioGrupo(producto.envioGrupoId);
    } else if (oldEnvioGrupo) {
      await this.recalcEnvioGrupo(oldEnvioGrupo);
      if (producto.valor) {
        producto.valor.costoEnvioProrrateado = producto.valor.costoEnvio;
        producto.valor.costoTotalProrrateado = producto.valor.costoTotal;
        await this.valorRepo.save(producto.valor);
      }
    } else if (producto.valor) {
      producto.valor.costoEnvioProrrateado = producto.valor.costoEnvio;
      producto.valor.costoTotalProrrateado = producto.valor.costoTotal;
      await this.valorRepo.save(producto.valor);
    }
    if (justLinkedToGroup && producto.envioGrupoId) {
      await this.syncTrackingEnGrupo(producto.envioGrupoId);
    }

    // 5) Retornar entidad completa actualizada (incluye tracking)
    const updated = await this.productoRepo.findOneOrFail({
      where: { id },
      relations: ['detalle', 'valor', 'tracking'],
    });
    await this.invalidateListCache();
    return this.applyProrrateadoView(updated);
  }

  /** Elimina un producto (y cascada en detalle/valor/tracking si estÃ¡ configurada) */
  async remove(id: number): Promise<void> {
    const producto = await this.productoRepo.findOne({
      where: { id },
      relations: ['detalle', 'valor', 'tracking'],
    });

    if (!producto) {
      throw new NotFoundException(`Producto con id ${id} no encontrado`);
    }

    const envioGrupoId = producto.envioGrupoId || null;
    await this.productoRepo.remove(producto);

    if (envioGrupoId) {
      await this.recalcEnvioGrupo(envioGrupoId);
    }
    await this.invalidateListCache();
  }


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

  // Nuevas utilidades para sincronizar con CatÃ¡logo
// SincronizaciÃ³n con CatÃ¡logo (mÃ©todos agregados al mismo servicio)
  // Determina si un producto estÃ¡ disponible: Ãºltimo tracking 'recogido' y sin ventas
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

  private getUltimoTrackingEstado(prod: any): string {
    const trk = Array.isArray((prod as any).tracking) ? [...(prod as any).tracking] : [];
    if (!trk.length) return '';
    trk.sort((a, b) => {
      if (a.createdAt && b.createdAt) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return (b.id || 0) - (a.id || 0);
    });
    return String(trk[0]?.estado || '').toLowerCase();
  }

  private isLinkable(prod: any): boolean {
    const estado = this.getUltimoTrackingEstado(prod);
    return ['comprado_sin_tracking', 'comprado_en_camino', 'en_eshopex'].includes(estado);
  }

  private getCasillero(prod: any): string | null {
    const trk = Array.isArray((prod as any).tracking) ? [...(prod as any).tracking] : [];
    if (!trk.length) return null;
    trk.sort((a, b) => {
      if (a.createdAt && b.createdAt) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return (b.id || 0) - (a.id || 0);
    });
    return trk[0]?.casillero ?? null;
  }

  private async ensureEnvioGrupo(
    targetId: number,
    requiredCasillero?: string | null,
    preferGroupId?: string | null,
  ): Promise<string> {
    const target = await this.productoRepo.findOne({
      where: { id: targetId },
      relations: ['tracking', 'valor'],
    });
    if (!target) throw new NotFoundException(`Producto con id ${targetId} no encontrado para vincular`);
    if (!this.isLinkable(target)) {
      throw new BadRequestException('Solo se pueden vincular productos sin tracking / en camino / en eshopex');
    }

    const targetCas = this.getCasillero(target);
    if (requiredCasillero && targetCas && targetCas !== requiredCasillero) {
      throw new BadRequestException(`Solo se pueden vincular productos del casillero ${requiredCasillero}`);
    }

    let envioGrupoId = preferGroupId || target.envioGrupoId || `grp-${crypto.randomUUID()}`;
    if (!target.envioGrupoId || target.envioGrupoId !== envioGrupoId) {
      target.envioGrupoId = envioGrupoId;
      await this.productoRepo.save(target);
    }
    const count = await this.productoRepo.count({ where: { envioGrupoId } });
    if (count >= 7) {
      throw new BadRequestException('El grupo de envío ya tiene 7 productos');
    }
    return envioGrupoId;
  }

  private async recalcEnvioGrupo(envioGrupoId: string) {
    const prods = await this.productoRepo.find({
      where: { envioGrupoId },
      relations: ['valor'],
      order: { id: 'ASC' },
    });
    const conValor = prods.filter((p) => p.valor);
    if (!conValor.length) return;

    // Si queda solo 1 producto, se elimina el grupo y se dejan valores individuales
    if (conValor.length < 2) {
      for (const p of conValor) {
        const v = p.valor!;
        (v as any).costoEnvioProrrateado = null;
        (v as any).costoTotalProrrateado = null;
        p.envioGrupoId = null;
        await this.valorRepo.save(v);
        await this.productoRepo.save(p);
      }
      return;
    }

    const pesoRef = Number(conValor[0].valor?.peso ?? 0);
    const valorDecBase = conValor.reduce(
      (max, p) => Math.max(max, Number(p.valor?.valorDec ?? 0)),
      0,
    );

    // Costo de envío total usando fórmula normal con peso y valorDec base (como producto individual)
    const tarifaBase = this.getTarifa(pesoRef);
    const hasta3kg = this.getTarifa(Math.min(pesoRef, 3));
    let descuento = Number((hasta3kg * 0.35).toFixed(2));
    if (descuento > 41.99) descuento = 41.99;
    const tarifaFinal = Number((tarifaBase - descuento).toFixed(2));
    const honorarios = this.getHonorarios(valorDecBase);
    const seguro = this.getSeguro(valorDecBase);
    const totalEnvio = Number((tarifaFinal + honorarios + seguro).toFixed(2));

    const totalPrecio = conValor.reduce((sum, p) => sum + Number(p.valor?.valorProducto ?? 0), 0);
    if (!totalPrecio) return;

    // Asignación proporcional por valorProducto asegurando suma exacta
    let acumulado = 0;
    conValor.forEach((p, idx) => {
      const v = p.valor!;
      // Recalcular valorSoles con TC fijo actual
      v.valorSoles = Number((Number(v.valorProducto) * 3.7).toFixed(2));

      const factor = Number(v.valorProducto ?? 0) / totalPrecio;
      let asignado = Number((totalEnvio * factor).toFixed(2));
      // Último elemento recibe el residual para cuadrar la suma
      if (idx === conValor.length - 1) {
        asignado = Number((totalEnvio - acumulado).toFixed(2));
      } else {
        acumulado += asignado;
      }
      v.costoEnvioProrrateado = asignado;
      const baseSoles = Number(v.valorSoles ?? 0);
      v.costoTotalProrrateado = Number((baseSoles + asignado).toFixed(2));
      this.valorRepo.save(v).catch(() => undefined);
    });
  }

  
  // SWR cache para KPIs de gestión de productos
  private readonly inflight = new Set<string>();

  async statsCached() {
    const key = 'productos:stats';
    const cached: any = await this.cache.get(key);
    const now = Date.now();
    const revalidateMs = 60_000; // refresco en background cada 1 min
    const ttlSeconds = 300; // mantener 5 min en cache
    if (cached?.data) {
      const age = now - (cached.cachedAt || 0);
      if (age > revalidateMs && !this.inflight.has(key)) {
        this.inflight.add(key);
        this.stats()
          .then((data) => this.cache.set(key, { data, cachedAt: Date.now() }, ttlSeconds))
          .finally(() => this.inflight.delete(key));
      }
      return cached.data;
    }
    const data = await this.stats();
    await this.cache.set(key, { data, cachedAt: now }, ttlSeconds);
    return data;
  }

  /** KPIs: disponibles, vendidos, totalVentas, gananciaTotal */
  async stats() {
    // vendidos y sumas de venta/ganancia
    const [vendidos, sumVentaRaw, sumGanRaw] = await Promise.all([
      this.ventaRepo.count(),
      this.ventaRepo
        .createQueryBuilder('v')
        .select('COALESCE(SUM(v.precioVenta),0)', 's')
        .getRawOne(),
      this.ventaRepo
        .createQueryBuilder('v')
        .select('COALESCE(SUM(v.ganancia),0)', 's')
        .getRawOne(),
    ]);

    // disponibles: tracking recogido o fechaRecogido y sin ventas
    const disponibles = await this.productoRepo
      .createQueryBuilder('p')
      .where('EXISTS (SELECT 1 FROM tracking t WHERE t.productoId = p.id AND (t.estado = :rec OR t.fechaRecogido IS NOT NULL))', { rec: 'recogido' })
      .andWhere('NOT EXISTS (SELECT 1 FROM venta v WHERE v.productoId = p.id)')
      .getCount();

    const totalVentas = Number((sumVentaRaw as any)?.s ?? 0);
    const gananciaTotal = Number((sumGanRaw as any)?.s ?? 0);

    return { disponibles, vendidos, totalVentas, gananciaTotal };
  }

  async resumenCached(refresh?: boolean) {
    if (refresh) return this.resumen();
    const key = 'productos:resumen';
    const cached: any = await this.cache.get(key);
    const now = Date.now();
    const revalidateMs = 60_000;
    const ttlSeconds = 300;
    if (cached?.data) {
      const age = now - (cached.cachedAt || 0);
      if (age > revalidateMs && !this.inflight.has(key)) {
        this.inflight.add(key);
        this.resumen()
          .then((data) => this.cache.set(key, { data, cachedAt: Date.now() }, ttlSeconds))
          .finally(() => this.inflight.delete(key));
      }
      return cached.data;
    }
    const data = await this.resumen();
    await this.cache.set(key, { data, cachedAt: now }, ttlSeconds);
    return data;
  }

  async resumen() {
    const productos = await this.productoRepo.find({
      relations: ['valor', 'tracking'],
      order: { id: 'DESC' },
    });
    const ventasMin = await this.ventaRepo.find({ select: { productoId: true } as any });
    const vendidosSet = new Set<number>(ventasMin.map((v: any) => v.productoId));
    const [sumVentaRaw, sumGanRaw] = await Promise.all([
      this.ventaRepo
        .createQueryBuilder('v')
        .select('COALESCE(SUM(v.precioVenta),0)', 's')
        .getRawOne(),
      this.ventaRepo
        .createQueryBuilder('v')
        .select('COALESCE(SUM(v.ganancia),0)', 's')
        .getRawOne(),
    ]);

    let total = 0;
    let sinTracking = 0;
    let enCamino = 0;
    let enEshopex = 0;
    let disponible = 0;
    let totalGastadoUsd = 0;
    let totalEnvioPen = 0;
    let totalDecUsd = 0;
    let totalCostoPen = 0;

    const latestEstado = (p: any) => {
      const trk = Array.isArray(p.tracking) ? [...p.tracking] : [];
      if (!trk.length) return '';
      trk.sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        return (b.id || 0) - (a.id || 0);
      });
      return String(trk[0]?.estado || '').toLowerCase();
    };

    for (const raw of productos) {
      const p = this.applyProrrateadoView(raw);
      total += 1;
      const estado = latestEstado(p);
      if (!estado || estado === 'comprado_sin_tracking') sinTracking += 1;
      if (estado === 'comprado_en_camino') enCamino += 1;
      if (estado === 'en_eshopex') enEshopex += 1;
      if (estado === 'recogido' && !vendidosSet.has(p.id)) disponible += 1;

      const v: any = p.valor || {};
      totalGastadoUsd += Number(v.valorProducto ?? 0) || 0;
      totalEnvioPen += Number(v.costoEnvio ?? 0) || 0;
      totalDecUsd += Number(v.valorDec ?? 0) || 0;
      totalCostoPen += Number(v.costoTotal ?? 0) || 0;
    }

    const totalVentaPen = Number((sumVentaRaw as any)?.s ?? 0);
    const gananciaPen = Number((sumGanRaw as any)?.s ?? 0);

    return {
      total,
      sinTracking,
      enCamino,
      enEshopex,
      disponible,
      vendido: vendidosSet.size,
      totalGastadoUsd,
      totalEnvioPen,
      totalDecUsd,
      totalCostoPen,
      totalVentaPen,
      gananciaPen,
    };
  }

  private buildTitle(p: any): string {
    const tipo = (p.tipo || '').toString();
    const d: any = p.detalle || {};
    const numero = d?.numero ? String(d.numero) : '';
    const modelo = (d?.modelo || '').toString();
    const proc = (d?.procesador || '').toString();
    const tam = ((d as any)?.tamano || '').toString();
    if (tipo.toLowerCase() === 'iphone') {
      const base = ['iPhone', numero, modelo].filter(Boolean).join(' ').trim();
      return base || `Producto ${p.id}`;
    }
    return [tipo, modelo, proc, tam].filter(Boolean).join(' ').trim() || `Producto ${p.id}`;
  }

  private buildPayload(p: any) {
    const price = p?.valor?.costoTotal ?? p?.valor?.valorSoles ?? 0;
    // Ãºltimo tracking (si existe)
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
      // Enviamos especificaciones completas para que el catÃ¡logo pueda mostrarlas
      specs: {
        tipo: p.tipo ?? null,
        estado: p.estado ?? null,
        accesorios: p.accesorios ?? null,
        detalle: p.detalle ?? null,
        valor: p.valor ?? null,
        tracking_last: last,
      },
    };
  }

  private hmac(body: string, secret: string) {
    return crypto.createHmac('sha256', secret || '').update(body).digest('hex');
  }

  /** Cuando se vincula un producto, replica el tracking mÃ¡s completo del grupo hacia todos */
  private async syncTrackingEnGrupo(envioGrupoId: string): Promise<void> {
    if (!envioGrupoId) return;
    const peers = await this.productoRepo.find({
      where: { envioGrupoId },
    });
    if (!peers.length) return;

    const latestByPeer: Tracking[] = [];
    for (const peer of peers) {
      const t = await this.trackingRepo.find({
        where: { productoId: peer.id },
        order: { id: 'DESC' },
        take: 1,
      });
      if (t[0]) latestByPeer.push(t[0]);
    }
    const source = this.pickBestTracking(latestByPeer);
    if (!source) return;

    const payload: Partial<Tracking> = {
      trackingUsa: source.trackingUsa ?? undefined,
      transportista: source.transportista ?? undefined,
      casillero: source.casillero ?? undefined,
      trackingEshop: source.trackingEshop ?? undefined,
      estatusEsho: (source as any)?.estatusEsho ?? undefined,
      fechaRecepcion: (source as any)?.fechaRecepcion ?? null,
      fechaRecogido: (source as any)?.fechaRecogido ?? null,
    };
    const estado = this.calcularEstadoTracking(payload);

    for (const peer of peers) {
      const existing = await this.trackingRepo.find({
        where: { productoId: peer.id },
        order: { id: 'DESC' },
        take: 1,
      });
      if (existing[0]) {
        Object.assign(existing[0], payload, { estado });
        await this.trackingRepo.save(existing[0]);
      } else {
        const created = this.trackingRepo.create({
          ...payload,
          productoId: peer.id,
          estado,
        } as any);
        await this.trackingRepo.save(created);
      }
      await this.syncFacturaFlagLocal(peer.id, estado);
    }
  }

  private pickBestTracking(trackings: Tracking[]): Tracking | null {
    if (!Array.isArray(trackings) || !trackings.length) return null;
    const scored = trackings
      .filter(Boolean)
      .map((t) => ({
        t,
        score: [
          t.trackingUsa,
          t.transportista,
          t.casillero,
          t.trackingEshop,
          (t as any)?.estatusEsho,
          (t as any)?.fechaRecepcion,
          (t as any)?.fechaRecogido,
        ].filter((v) => v !== null && v !== undefined && String(v).trim().length).length,
        ts: new Date((t as any)?.updatedAt || (t as any)?.createdAt || 0).getTime(),
        id: t.id || 0,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.ts !== a.ts) return b.ts - a.ts;
        return b.id - a.id;
      });
    return scored[0]?.t ?? null;
  }

  private calcularEstadoTracking(input: {
    trackingUsa?: string | null;
    transportista?: string | null;
    casillero?: string | null;
    trackingEshop?: string | null;
    fechaRecepcion?: string | null;
    fechaRecogido?: string | null;
  }): EstadoTracking {
    const clean = (v?: string | null) => {
      if (v == null) return null;
      const s = String(v).trim();
      return s.length ? s : null;
    };
    const hasUsa = !!clean(input.trackingUsa) || !!clean(input.transportista);
    const hasEshop = !!clean(input.trackingEshop) || !!clean(input.fechaRecepcion);
    if (clean(input.fechaRecogido)) return 'recogido';
    if (hasEshop) return 'en_eshopex';
    if (hasUsa) return 'comprado_en_camino';
    return 'comprado_sin_tracking';
  }

  private async syncFacturaFlagLocal(productoId: number, estado: EstadoTracking): Promise<void> {
    if (!productoId) return;
    if (estado !== 'en_eshopex' && estado !== 'recogido') return;
    await this.productoRepo.update(
      { id: productoId, facturaDecSubida: false },
      { facturaDecSubida: true },
    );
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
        // Evitar duplicados consultando el catÃ¡logo por SKU
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
              accesorios: p.accesorios ?? null,
              detalle: {
                id: d?.id ?? null,
                gama: d?.gama ?? null,
                procesador: d?.procesador ?? null,
                generacion: d?.generacion ?? null,
                modelo: d?.modelo ?? null,
                tamano: (d as any)?.tamano ?? null,
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
