import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Venta } from './venta.entity';
import { CreateVentaDto } from './dto/create-venta.dto';
import { UpdateVentaDto } from './dto/update-venta.dto';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';

@Injectable()
export class VentaService {
  constructor(
    @InjectRepository(Venta) private readonly ventaRepo: Repository<Venta>,
    @InjectRepository(Producto) private readonly productoRepo: Repository<Producto>,
    @InjectRepository(ProductoValor) private readonly valorRepo: Repository<ProductoValor>,
  ) {}

  async findByProducto(productoId: number): Promise<Venta[]> {
    return this.ventaRepo.find({ where: { productoId }, order: { id: 'DESC' } });
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
    if (!producto) throw new NotFoundException(`Producto ${dto.productoId} no encontrado`);
    if (!producto.valor) throw new BadRequestException('El producto no tiene sección de valor asociada');

    const v = producto.valor;

    // 2) Recalcular costos con el tipo de cambio ingresado
    const valorProductoUSD = Number(v.valorProducto);    // USD
    const costoEnvioSoles  = Number(v.costoEnvio ?? 0);  // S/
    const tipoCambio       = Number(dto.tipoCambio);

    const valorSolesRecalc = +(valorProductoUSD * tipoCambio).toFixed(2);
    const costoTotalRecalc = +(valorSolesRecalc + costoEnvioSoles).toFixed(2);

    // Persistir nuevos valores en ProductoValor
    v.valorSoles = valorSolesRecalc;
    v.costoTotal = costoTotalRecalc;
    await this.valorRepo.save(v);

    // 3) Calcular ganancia y porcentaje
    const precioVenta = Number(dto.precioVenta);
    const ganancia = +(precioVenta - costoTotalRecalc).toFixed(2);
    const porcentajeGanancia = +((ganancia / (costoTotalRecalc || 1)) * 100).toFixed(3);

    // 4) Crear venta
    const venta = this.ventaRepo.create({
      productoId: producto.id,
      tipoCambio,
      fechaVenta: dto.fechaVenta,
      precioVenta,
      ganancia,
      porcentajeGanancia,
    });
    return this.ventaRepo.save(venta);
  }

  async update(id: number, dto: UpdateVentaDto): Promise<Venta> {
    const venta = await this.findOne(id);

    // Si actualizan tipoCambio o precioVenta, recomputamos con el estado ACTUAL del producto
    if (dto.tipoCambio !== undefined || dto.precioVenta !== undefined) {
      const producto = await this.productoRepo.findOne({
        where: { id: venta.productoId },
        relations: ['valor'],
      });
      if (!producto?.valor) throw new BadRequestException('El producto no tiene sección de valor asociada');

      const tipoCambio = dto.tipoCambio !== undefined ? Number(dto.tipoCambio) : Number(venta.tipoCambio);
      const precioVenta = dto.precioVenta !== undefined ? Number(dto.precioVenta) : Number(venta.precioVenta);

      const v = producto.valor;
      const valorSolesRecalc = +(Number(v.valorProducto) * tipoCambio).toFixed(2);
      const costoTotalRecalc = +(valorSolesRecalc + Number(v.costoEnvio ?? 0)).toFixed(2);

      v.valorSoles = valorSolesRecalc;
      v.costoTotal = costoTotalRecalc;
      await this.valorRepo.save(v);

      venta.tipoCambio = tipoCambio;
      venta.precioVenta = precioVenta;
      venta.ganancia = +(precioVenta - costoTotalRecalc).toFixed(2);
      venta.porcentajeGanancia = +((venta.ganancia / (costoTotalRecalc || 1)) * 100).toFixed(3);
    }

    if (dto.fechaVenta !== undefined) venta.fechaVenta = dto.fechaVenta;

    return this.ventaRepo.save(venta);
  }

  async remove(id: number): Promise<void> {
    const venta = await this.ventaRepo.findOne({ where: { id } });
    if (!venta) throw new NotFoundException(`Venta ${id} no encontrada`);
    await this.ventaRepo.remove(venta);
  }
}
