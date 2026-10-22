import { IsNull } from 'typeorm';

export const reservaActivaSql = (alias = 'va') => `${alias}."completadoAt" IS NULL AND ${alias}."canceladoAt" IS NULL`;
export const reservaActivaWhere = (productoId: number) => ({ productoId, completadoAt: IsNull(), canceladoAt: IsNull() });
export const ventaActivaSql = (alias = 'v') => `${alias}."estadoComercial" <> 'cancelada'`;
