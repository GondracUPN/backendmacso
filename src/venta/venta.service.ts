import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Venta } from './venta.entity';
import { VentaAdelanto } from './venta-adelanto.entity';
import { CreateVentaDto } from './dto/create-venta.dto';
import { UpdateVentaDto } from './dto/update-venta.dto';
import { CreateVentaAdelantoDto } from './dto/create-venta-adelanto.dto';
import { CompleteVentaAdelantoDto } from './dto/complete-venta-adelanto.dto';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';

const normalizeSeller = (s?: string | null) =>
  s == null ? '' : String(s).trim().toLowerCase();
const isSplitSeller = (s?: string | null) => normalizeSeller(s) === 'ambos';

const calcSplitCosts = (usdTotal: number, envioSoles: number, tcG: number, tcR: number) => {
  const halfUsd = usdTotal / 2;
  const halfEnvio = envioSoles / 2;
  const costoG = +(halfUsd * tcG + halfEnvio).toFixed(2);
  const costoR = +(halfUsd * tcR + halfEnvio).toFixed(2);
  const total = +(costoG + costoR).toFixed(2);
  const valorSoles = +(usdTotal * ((tcG + tcR) / 2)).toFixed(2);
  return { costoG, costoR, total, valorSoles };
};

// 👇 filtros para listar ventas (export opcional)
export type ListVentasParams = {
  from?: string; // 'YYYY-MM-DD'
  to?: string; // 'YYYY-MM-DD'
  unassigned?: boolean; // ventas sin vendedor
  productoId?: number; // opcional
};

@Injectable()
export class VentaService {
  constructor(
    @InjectRepository(Venta) private readonly ventaRepo: Repository<Venta>,
    @InjectRepository(VentaAdelanto)
    private readonly adelantoRepo: Repository<VentaAdelanto>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(ProductoValor)
    private readonly valorRepo: Repository<ProductoValor>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // Lista con filtros + joins para devolver producto, valor y detalle
  async findAll(params: ListVentasParams) {
    const qb = this.ventaRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.producto', 'p')
      .leftJoinAndSelect('p.valor', 'val')
      .leftJoinAndSelect('p.detalle', 'det');

    if (params.productoId != null) {
      qb.andWhere('v.productoId = :pid', { pid: params.productoId });
    }
    if (params.from) {
      qb.andWhere('v.fechaVenta >= :from', { from: params.from });
    }
    if (params.to) {
      qb.andWhere('v.fechaVenta <= :to', { to: params.to });
    }
    if (params.unassigned) {
      // requiere columna 'vendedor' en la entidad Venta
      qb.andWhere("(v.vendedor IS NULL OR v.vendedor = '')");
    }

    return qb
      .orderBy('v.fechaVenta', 'DESC')
      .addOrderBy('v.id', 'DESC')
      .getMany();
  }

  async findByProducto(productoId: number): Promise<Venta[]> {
    return this.ventaRepo.find({
      where: { productoId },
      order: { id: 'DESC' },
    });
  }

  // Devuelve la Ð¥ltima venta por producto (opcionalmente filtrando por IDs) en una sola query
  async findLatestByProductos(productoIds?: number[]): Promise<Venta[]> {
    const qb = this.ventaRepo
      .createQueryBuilder('v')
      .distinctOn(['v.productoId'])
      .orderBy('v.productoId', 'ASC')
      .addOrderBy('v.fechaVenta', 'DESC')
      .addOrderBy('v.id', 'DESC');

    if (productoIds?.length) {
      qb.where('v.productoId IN (:...productoIds)', { productoIds });
    }

    return qb.getMany();
  }

  async findLatestAdelantosByProductos(productoIds?: number[]): Promise<VentaAdelanto[]> {
    const qb = this.adelantoRepo
      .createQueryBuilder('a')
      .where('a.completadoAt IS NULL')
      .distinctOn(['a.productoId'])
      .orderBy('a.productoId', 'ASC')
      .addOrderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC');

    if (productoIds?.length) {
      qb.andWhere('a.productoId IN (:...productoIds)', { productoIds });
    }

    return qb.getMany();
  }

  async createAdelanto(dto: CreateVentaAdelantoDto): Promise<VentaAdelanto> {
    const producto = await this.productoRepo.findOne({
      where: { id: dto.productoId },
    });
    if (!producto)
      throw new NotFoundException(`Producto ${dto.productoId} no encontrado`);

    const existingVenta = await this.ventaRepo.findOne({
      where: { productoId: producto.id },
      order: { id: 'DESC' },
    });
    if (existingVenta) {
      throw new BadRequestException('El producto ya tiene una venta registrada.');
    }

    const existingAdelanto = await this.adelantoRepo.findOne({
      where: { productoId: producto.id, completadoAt: IsNull() },
      order: { id: 'DESC' },
    });
    if (existingAdelanto) {
      throw new BadRequestException('El producto ya tiene un adelanto activo.');
    }

    const adelanto = this.adelantoRepo.create({
      productoId: producto.id,
      montoAdelanto: Number(dto.montoAdelanto),
      fechaAdelanto: dto.fechaAdelanto,
      montoVenta: Number(dto.montoVenta),
    });
    return this.adelantoRepo.save(adelanto);
  }

  async completeAdelanto(id: number, dto: CompleteVentaAdelantoDto): Promise<Venta> {
    const adelanto = await this.adelantoRepo.findOne({ where: { id } });
    if (!adelanto) throw new NotFoundException(`Adelanto ${id} no encontrado`);
    if (adelanto.completadoAt) {
      throw new BadRequestException('El adelanto ya fue completado.');
    }

    const producto = await this.productoRepo.findOne({
      where: { id: adelanto.productoId },
      relations: ['valor'],
    });
    if (!producto?.valor)
      throw new BadRequestException(
        'El producto no tiene seccion de valor asociada',
      );

    const v = producto.valor;
    const valorProductoUSD = Number(v.valorProducto);
    if (!valorProductoUSD) {
      throw new BadRequestException(
        'El producto no tiene valor USD para calcular el tipo de cambio.',
      );
    }
    const tipoCambio = Number(dto.tipoCambio);
    if (!tipoCambio) {
      throw new BadRequestException('Tipo de cambio invalido.');
    }
    const costoEnvioSoles = Number(
      (v as any).costoEnvioProrrateado ?? v.costoEnvio ?? 0,
    );
    const valorSolesRecalc = +(valorProductoUSD * tipoCambio).toFixed(2);
    const costoTotalRecalc = +(valorSolesRecalc + costoEnvioSoles).toFixed(2);

    v.valorSoles = valorSolesRecalc;
    v.costoTotal = costoTotalRecalc;
    await this.valorRepo.save(v);

    const precioVenta = Number(adelanto.montoVenta);
    const ganancia = +(precioVenta - costoTotalRecalc).toFixed(2);
    const base = Math.max(costoTotalRecalc - Number(adelanto.montoAdelanto || 0), 1);
    const porcentajeGanancia = +((ganancia / base) * 100).toFixed(3);

    const venta = this.ventaRepo.create({
      productoId: producto.id,
      tipoCambio,
      fechaVenta: dto.fechaVenta,
      precioVenta,
      ganancia,
      porcentajeGanancia,
      vendedor: null,
    });
    const saved = await this.ventaRepo.save(venta);

    adelanto.ventaId = saved.id;
    adelanto.completadoAt = new Date();
    await this.adelantoRepo.save(adelanto);
    await this.cache.del?.('productos:stats').catch?.(() => {});
    return saved;
  }

  async findOne(id: number): Promise<Venta> {
    const v = await this.ventaRepo.findOne({ where: { id } });
    if (!v) throw new NotFoundException(`Venta ${id} no encontrada`);
    return v;
  }

  async create(dto: CreateVentaDto): Promise<Venta> {
    // 1) Cargar producto con valor
    const producto = await this.productoRepo.findOne({
      where: { id: dto.productoId },
      relations: ['valor'],
    });
    if (!producto)
      throw new NotFoundException(`Producto ${dto.productoId} no encontrado`);
    if (!producto.valor)
      throw new BadRequestException(
        'El producto no tiene sección de valor asociada',
      );

    const v = producto.valor;

    // 2) Recalcular costos con el tipo de cambio ingresado
    const valorProductoUSD = Number(v.valorProducto); // USD
    const costoEnvioSoles = Number(
      (v as any).costoEnvioProrrateado ?? v.costoEnvio ?? 0,
    ); // S/

    const splitRequested =
      isSplitSeller((dto as any).vendedor) ||
      (dto as any).tipoCambioGonzalo != null ||
      (dto as any).tipoCambioRenato != null;

    if (splitRequested) {
      const tipoCambioGonzalo = Number(
        (dto as any).tipoCambioGonzalo ?? dto.tipoCambio,
      );
      const tipoCambioRenato = Number(
        (dto as any).tipoCambioRenato ?? dto.tipoCambio,
      );
      if (!tipoCambioGonzalo || !tipoCambioRenato) {
        throw new BadRequestException(
          'Tipo de cambio invalido para venta conjunta.',
        );
      }

      const { total, valorSoles } = calcSplitCosts(
        valorProductoUSD,
        costoEnvioSoles,
        tipoCambioGonzalo,
        tipoCambioRenato,
      );

      v.valorSoles = valorSoles;
      v.costoTotal = total;
      await this.valorRepo.save(v);

      const precioVenta = Number(dto.precioVenta);
      const ganancia = +(precioVenta - total).toFixed(2);
      const porcentajeGanancia = +(
        (ganancia / (total || 1)) *
        100
      ).toFixed(3);

      const avgTc = +(((tipoCambioGonzalo + tipoCambioRenato) / 2).toFixed(4));

      const venta = this.ventaRepo.create({
        productoId: producto.id,
        tipoCambio: avgTc,
        tipoCambioGonzalo,
        tipoCambioRenato,
        fechaVenta: dto.fechaVenta,
        precioVenta,
        ganancia,
        porcentajeGanancia,
        vendedor: 'ambos',
      });
      const saved = await this.ventaRepo.save(venta);
      // invalidar KPIs de productos
      await this.cache.del?.('productos:stats').catch?.(() => {});
      return saved;
    }

    const tipoCambio = Number(dto.tipoCambio);
    const valorSolesRecalc = +(valorProductoUSD * tipoCambio).toFixed(2);
    const costoTotalRecalc = +(valorSolesRecalc + costoEnvioSoles).toFixed(2);

    // Persistir nuevos valores en ProductoValor
    v.valorSoles = valorSolesRecalc;
    v.costoTotal = costoTotalRecalc;
    await this.valorRepo.save(v);

    // 3) Calcular ganancia y porcentaje
    const precioVenta = Number(dto.precioVenta);
    const ganancia = +(precioVenta - costoTotalRecalc).toFixed(2);
    const porcentajeGanancia = +(
      (ganancia / (costoTotalRecalc || 1)) *
      100
    ).toFixed(3);

    // 4) Crear venta (acepta vendedor opcional)
    const venta = this.ventaRepo.create({
      productoId: producto.id,
      tipoCambio,
      fechaVenta: dto.fechaVenta,
      precioVenta,
      ganancia,
      porcentajeGanancia,
      vendedor: (dto as any).vendedor ?? null, // opcional
    });
    const saved = await this.ventaRepo.save(venta);
    // invalidar KPIs de productos
    await this.cache.del?.('productos:stats').catch?.(() => {});
    return saved;
  }

  async update(id: number, dto: UpdateVentaDto): Promise<Venta> {
    const venta = await this.findOne(id);
    const nextVendedor =
      (dto as any).vendedor !== undefined ? (dto as any).vendedor : venta.vendedor;
    const splitMode =
      isSplitSeller(nextVendedor) ||
      (dto as any).tipoCambioGonzalo !== undefined ||
      (dto as any).tipoCambioRenato !== undefined;

    // Si actualizan tipoCambio o precioVenta, recomputamos con el estado ACTUAL del producto
    if (
      dto.tipoCambio !== undefined ||
      dto.precioVenta !== undefined ||
      (dto as any).tipoCambioGonzalo !== undefined ||
      (dto as any).tipoCambioRenato !== undefined
    ) {
      const producto = await this.productoRepo.findOne({
        where: { id: venta.productoId },
        relations: ['valor'],
      });
      if (!producto?.valor)
        throw new BadRequestException(
          'El producto no tiene seccion de valor asociada',
        );

      const precioVenta =
        dto.precioVenta !== undefined
          ? Number(dto.precioVenta)
          : Number(venta.precioVenta);

      const v = producto.valor;
      const valorProductoUSD = Number(v.valorProducto);
      const costoEnvioSoles = Number(
        (v as any).costoEnvioProrrateado ?? v.costoEnvio ?? 0,
      );

      if (splitMode) {
        const tipoCambioGonzalo = Number(
          (dto as any).tipoCambioGonzalo ??
            venta.tipoCambioGonzalo ??
            venta.tipoCambio ??
            dto.tipoCambio,
        );
        const tipoCambioRenato = Number(
          (dto as any).tipoCambioRenato ??
            venta.tipoCambioRenato ??
            venta.tipoCambio ??
            dto.tipoCambio,
        );
        if (!tipoCambioGonzalo || !tipoCambioRenato) {
          throw new BadRequestException(
            'Tipo de cambio invalido para venta conjunta.',
          );
        }

        const { total, valorSoles } = calcSplitCosts(
          valorProductoUSD,
          costoEnvioSoles,
          tipoCambioGonzalo,
          tipoCambioRenato,
        );

        v.valorSoles = valorSoles;
        v.costoTotal = total;
        await this.valorRepo.save(v);

        const avgTc = +(((tipoCambioGonzalo + tipoCambioRenato) / 2).toFixed(4));
        venta.tipoCambio = avgTc;
        venta.tipoCambioGonzalo = tipoCambioGonzalo;
        venta.tipoCambioRenato = tipoCambioRenato;
        venta.precioVenta = precioVenta;
        venta.ganancia = +(precioVenta - total).toFixed(2);
        venta.porcentajeGanancia = +(
          (venta.ganancia / (total || 1)) *
          100
        ).toFixed(3);
      } else {
        const tipoCambio =
          dto.tipoCambio !== undefined
            ? Number(dto.tipoCambio)
            : Number(venta.tipoCambio);

        const valorSolesRecalc = +(valorProductoUSD * tipoCambio).toFixed(2);
        const costoTotalRecalc = +(
          valorSolesRecalc +
          Number((v as any).costoEnvioProrrateado ?? v.costoEnvio ?? 0)
        ).toFixed(2);

        v.valorSoles = valorSolesRecalc;
        v.costoTotal = costoTotalRecalc;
        await this.valorRepo.save(v);

        venta.tipoCambio = tipoCambio;
        venta.tipoCambioGonzalo = null;
        venta.tipoCambioRenato = null;
        venta.precioVenta = precioVenta;
        venta.ganancia = +(precioVenta - costoTotalRecalc).toFixed(2);
        venta.porcentajeGanancia = +(
          (venta.ganancia / (costoTotalRecalc || 1)) *
          100
        ).toFixed(3);
      }
    }
    // permitir asignar vendedor
    if ((dto as any).vendedor !== undefined) {
      // guardar string o null si viene vacío
      venta.vendedor = (dto as any).vendedor || null;
    }

    if (dto.fechaVenta !== undefined) venta.fechaVenta = dto.fechaVenta;

    const saved = await this.ventaRepo.save(venta);
    await this.cache.del?.('productos:stats').catch?.(() => {});
    return saved;
  }

  async remove(id: number): Promise<void> {
    const venta = await this.ventaRepo.findOne({ where: { id } });
    if (!venta) throw new NotFoundException(`Venta ${id} no encontrada`);
    await this.ventaRepo.remove(venta);
    await this.cache.del?.('productos:stats').catch?.(() => {});
  }
}

