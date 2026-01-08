import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Venta } from './venta.entity';
import { CreateVentaDto } from './dto/create-venta.dto';
import { UpdateVentaDto } from './dto/update-venta.dto';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';

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

    // Si actualizan tipoCambio o precioVenta, recomputamos con el estado ACTUAL del producto
    if (dto.tipoCambio !== undefined || dto.precioVenta !== undefined) {
      const producto = await this.productoRepo.findOne({
        where: { id: venta.productoId },
        relations: ['valor'],
      });
      if (!producto?.valor)
        throw new BadRequestException(
          'El producto no tiene sección de valor asociada',
        );

      const tipoCambio =
        dto.tipoCambio !== undefined
          ? Number(dto.tipoCambio)
          : Number(venta.tipoCambio);
      const precioVenta =
        dto.precioVenta !== undefined
          ? Number(dto.precioVenta)
          : Number(venta.precioVenta);

      const v = producto.valor;
      const valorSolesRecalc = +(Number(v.valorProducto) * tipoCambio).toFixed(
        2,
      );
      const costoTotalRecalc = +(
        valorSolesRecalc +
        Number((v as any).costoEnvioProrrateado ?? v.costoEnvio ?? 0)
      ).toFixed(2);

      v.valorSoles = valorSolesRecalc;
      v.costoTotal = costoTotalRecalc;
      await this.valorRepo.save(v);

      venta.tipoCambio = tipoCambio;
      venta.precioVenta = precioVenta;
      venta.ganancia = +(precioVenta - costoTotalRecalc).toFixed(2);
      venta.porcentajeGanancia = +(
        (venta.ganancia / (costoTotalRecalc || 1)) *
        100
      ).toFixed(3);
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
