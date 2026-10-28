import { Producto } from '../producto/producto.entity';
import { detectAccessoryOriginality } from '../producto/accessory-rules';
import { AccesorioReferencia, normalizeReferenceText as norm, referenceIdentityKeys } from './accesorio-referencia.entity';
import { operationHash } from '../venta/operation-hash';
import { accessoryOwner } from '../venta/accessory-quote';

export const legacyGroup = (lot: Partial<Producto>) => `${Number(lot.codigoInventario || lot.id)}:${accessoryOwner(lot.vendedor)}`;
export const referenceSignature = (value: any) => operationHash(Object.fromEntries(referenceIdentityKeys.map((key) => [key, norm(value?.[key])])));
export const snapshotLots = (lots: Producto[]) => [...lots].sort((a, b) => a.id - b.id).map((lot) => ({
  id: lot.id, codigoInventario: lot.codigoInventario ?? null, vendedor: lot.vendedor ?? null,
  stockInicial: Number(lot.stockInicial), stockActual: Number(lot.stockActual), referenciaId: lot.referenciaId ?? null,
  estado: lot.estado ?? '', detalle: lot.detalle ?? null, archivadoAt: lot.archivadoAt ?? null, cierreMotivo: lot.cierreMotivo ?? null,
}));

export function proposeAccessory(lots: Producto[], references: AccesorioReferencia[], codeLots: Producto[] = lots) {
  const first = lots[0], detail = first.detalle || {} as any;
  const text = norm([detail.modelo, detail.gama, detail.generacion, detail.descripcionOtro].filter(Boolean).join(' '));
  const originalidad = detectAccessoryOriginality(text);
  const category = norm(detail.gama) || ['cargador', 'cable', 'pencil', 'airtag', 'keyboard', 'funda', 'case', 'correa'].find((word) => text.includes(word)) || '';
  const variantParts = text.match(/\b\d+(?:[.,]\d+)?\s*w\b|usb[ -]?[ac]|lightning|magsafe\s*\d?|\b\d+(?:[.,]\d+)?\s*(?:cm|m)\b|negro|blanco|azul|rojo|gris/g) || [];
  const data = { categoria: category, marca: ['apple', 'logitech', 'anker', 'belkin'].find((brand) => new RegExp('\\b' + brand + '\\b').test(text)) || '',
    modelo: norm(detail.modelo || detail.descripcionOtro), generacion: norm(detail.generacion),
    variante: norm(detail.descripcionOtro) || [...new Set(variantParts)].join(' '), estado: norm(first.estado), originalidad,
    compatibilidad: (detail.modelosCompatibles || []).join(', ') };
  const missing: string[] = [];
  if (!originalidad) missing.push('originalidad desconocida o contradictoria');
  if (!data.estado) missing.push('estado vacío');
  else if (!['nuevo', 'usado', 'open_box', 'reacondicionado', 'roto'].includes(data.estado)) missing.push('estado sin normalizar');
  if (!data.modelo) missing.push('modelo faltante');
  if (!data.categoria) missing.push('categoría faltante');
  if (!data.variante) missing.push('variante faltante');
  if (/cable|cargador|charger|adaptador/.test(category)) {
    if (!/\d+(?:[.,]\d+)?\s*w\b/.test(text)) missing.push('potencia faltante');
    if (!/usb[ -]?[ac]|lightning|magsafe/.test(text)) missing.push('conector faltante');
  }
  // Detail IDs are storage identity, not a commercial difference.
  const signatures = new Set(codeLots.map((lot) => {
    const { id, ...fields } = (lot.detalle || {}) as any;
    return operationHash({ detalle: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Array.isArray(value) ? value.map(norm).sort() : norm(value)])), estado: norm(lot.estado) });
  }));
  if (signatures.size > 1) missing.push('lotes del mismo código con detalles distintos entre sí');
  const match = references.find((reference) => referenceSignature(reference) === referenceSignature(data));
  if (match && !match.activo) missing.push('la referencia coincidente está inactiva');
  return { datosReferenciaPropuesta: data, referenciaId: match?.id ?? null, ambigua: missing.length > 0,
    puntuacion: missing.length ? Math.max(10, 45 - missing.length * 5) : match ? 100 : 90,
    motivo: `Campos tomados del lote: modelo, gama, generación, descripción, compatibilidad y estado. ${match ? 'Coincidencia de identidad normalizada con referencia #' + match.id + '.' : 'Se propone crear una referencia nueva.'} ${missing.length ? 'Revisar: ' + missing.join('; ') + '.' : 'Identidad completa; requiere confirmación del administrador.'}` };
}
