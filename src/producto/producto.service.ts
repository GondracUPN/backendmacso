import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Producto } from './producto.entity';
import { ProductoDetalle } from './producto-detalle.entity';
import { ProductoValor } from './producto-valor.entity';
import { CreateProductoDto } from './dto/create-producto.dto';
import { UpdateProductoDto } from './dto/update-producto.dto';
import { Tracking } from '../tracking/tracking.entity';

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
  ) { }

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
        estado: 'comprado_sin_tracking', // 👈 default inicial
      })
    );

    // 5) Retornar producto con todas las relaciones (incluye tracking)
    return this.productoRepo.findOneOrFail({
      where: { id: savedProducto.id },
      relations: ['detalle', 'valor', 'tracking'],
    });
  }

  /** Devuelve todos los productos con sus relaciones */
  async findAll(): Promise<Producto[]> {
    return this.productoRepo.find({
      relations: ['detalle', 'valor', 'tracking'],
      order: { id: 'DESC' }, // último ingresado primero
    });
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
      relations: ['detalle', 'valor', 'tracking'], // 👈 incluye tracking
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
      [0.5, 30.6], [1.0, 55], [1.5, 74], [2.0, 90],
      [2.5, 110], [3.0, 120], [3.5, 130], [4.0, 140],
      [4.5, 150], [5.0, 160], [5.5, 170], [6.0, 180],
      [6.5, 190], [7.0, 200], [7.5, 210], [8.0, 220],
      [8.5, 230], [9.0, 240], [9.5, 250], [10.0, 260],
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
}
