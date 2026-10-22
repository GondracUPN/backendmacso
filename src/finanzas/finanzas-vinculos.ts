import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Venta } from '../venta/venta.entity';
import { Producto } from '../producto/producto.entity';

/** Comprueba que la venta o el producto vinculados a un gasto existan. */
export async function validarVinculos(
  manager: EntityManager,
  dto: {
    ventaVinculadaId?: number | null;
    productoVinculadoId?: number | null;
    clasificacionFinanciera?: string | null;
  },
) {
  if (dto.ventaVinculadaId) {
    const ok = await manager
      .getRepository(Venta)
      .count({ where: { id: dto.ventaVinculadaId } });
    if (!ok) throw new BadRequestException('La venta vinculada no existe.');
  }
  if (dto.productoVinculadoId) {
    const ok = await manager
      .getRepository(Producto)
      .count({ where: { id: dto.productoVinculadoId } });
    if (!ok) throw new BadRequestException('El producto vinculado no existe.');
  }
}
