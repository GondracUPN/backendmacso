/** Formato de pedido ya utilizado por Ventas: Gonzalo (Nombre del cliente). */
export function pedidoCliente(
  vendedor?: string | null,
): { nombre: string; key: string } | null {
  const match = String(vendedor || '')
    .trim()
    .match(/^gonzalo\s*\(([^)]+)\)$/i);
  const nombre = match?.[1]?.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!nombre) return null;
  return { nombre, key: nombre.toLocaleLowerCase('es-PE') };
}
