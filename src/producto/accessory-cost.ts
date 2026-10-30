import { Producto } from './producto.entity';

export const isSimpleAccessory = (lot: Partial<Producto>) =>
  String(lot.tipo).toLowerCase() === 'accesorios' && !!lot.soloInventario && !lot.referenciaId;

/** Purchase and shipping are lot totals; simple accessories always use S/ 3.70 per USD. */
export function accessoryLotCost(lot: Partial<Producto>): number | null {
  const value = lot.valor;
  if (!value) return null;
  if (isSimpleAccessory(lot) && value.valorProducto != null) {
    const rate = String(value.monedaCompra || 'USD').toUpperCase() === 'PEN' ? 1 : 3.7;
    return Number((Number(value.valorProducto) * rate + Number(value.costoEnvioProrrateado ?? value.costoEnvio ?? 0)).toFixed(2));
  }
  const cost = value.costoTotalProrrateado ?? value.costoTotal ?? value.valorSoles;
  return cost == null ? null : Number(cost);
}
