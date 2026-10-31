import { lockAccessoryTopology } from '../venta/accessory-locks';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { AccesorioReferencia, normalizeReferenceText, referenceIdentityKeys } from './accesorio-referencia.entity';
import { AccesorioIngreso } from './accesorio-ingreso.entity';
import { EditReferenciaDto, IngresoAccesorioDto, ReferenciaDto } from './accesorios.dto';
import { ProductoService } from '../producto/producto.service';
import { Producto } from '../producto/producto.entity';
import { Inventario } from '../inventario/inventario.entity';
import { operationHash } from '../venta/operation-hash';
import { accessoryAvailable, accessoryInventoryIdentity, accessoryOwner, allocateAccessory, resolveAccessoryPrices } from '../venta/accessory-quote';
import { VentaService } from '../venta/venta.service';

@Injectable()
export class AccesoriosService {
  constructor(private readonly ds: DataSource, private readonly products: ProductoService, private readonly sales: VentaService) {}

  private identity(data: Partial<AccesorioReferencia>) {
    return Object.fromEntries(referenceIdentityKeys.map((key) => [key, normalizeReferenceText(data[key])]));
  }
  private assertPrices(data: Partial<AccesorioReferencia>) {
    if ((data.precioMayoristaSoles == null) !== (data.cantidadMinimaMayorista == null)) throw new BadRequestException('Completa precio mayorista y cantidad mínima juntos.');
    if (!normalizeReferenceText(data.categoria) || !normalizeReferenceText(data.modelo)) throw new BadRequestException('Categoría y modelo son obligatorios.');
  }
  async createReference(data: ReferenciaDto, manager?: EntityManager): Promise<AccesorioReferencia> {
    if (!manager) return this.ds.transaction((em) => this.createReference(data, em));
    await lockAccessoryTopology(manager);
    this.assertPrices(data);
    const identity = this.identity(data);
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['accref:' + operationHash(identity)]);
    const repo = manager.getRepository(AccesorioReferencia);
    const existing = await repo.findOne({ where: identity });
    if (existing) throw new ConflictException({ message: 'La referencia ya existe.', id: existing.id });
    return repo.save(repo.create({ ...data, ...identity }));
  }
  async getReference(id: number) {
    const row = await this.ds.getRepository(AccesorioReferencia).findOneBy({ id });
    if (!row) throw new NotFoundException('Referencia no encontrada.');
    return row;
  }
  async searchReferences(params: { q?: string; estado?: string; originalidad?: string; variante?: string; activo?: string }) {
    const qb = this.ds.getRepository(AccesorioReferencia).createQueryBuilder('r');
    if (params.q?.trim()) qb.andWhere(`(concat_ws(' ', r.categoria, r.marca, r.modelo, r.generacion, r.variante, r.compatibilidad, r.id::text) ILIKE :q OR r.id::text ILIKE :code
      OR EXISTS (SELECT 1 FROM producto p WHERE p."referenciaId" = r.id AND COALESCE(p."codigoInventario",p.id)::text ILIKE :code))`, { q: '%' + params.q.trim() + '%', code: '%' + params.q.trim().replace(/^(?:acc|ref)[\s_-]*/i, '') + '%' });
    for (const field of ['estado', 'originalidad', 'variante']) if (params[field]) qb.andWhere(`r.${field} = :${field}`, { [field]: normalizeReferenceText(params[field]) });
    if (params.activo !== 'todos') qb.andWhere('r.activo = :activo', { activo: params.activo !== 'false' });
    return qb.orderBy('r.modelo', 'ASC').addOrderBy('r.id', 'ASC').take(200).getMany();
  }
  async updateReference(id: number, patch: EditReferenciaDto) {
    return this.ds.transaction(async (em) => {
      await lockAccessoryTopology(em);
      const repo = em.getRepository(AccesorioReferencia);
      const row = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException('Referencia no encontrada.');
      const data = { ...row, ...patch };
      this.assertPrices(data);
      const identity = this.identity(data);
      if (referenceIdentityKeys.some((key) => identity[key] !== normalizeReferenceText(row[key]))
        && await em.getRepository(Producto).count({ where: { referenciaId: id } })) {
        throw new BadRequestException('La referencia ya tiene lotes. Para otra variante crea una referencia nueva; puedes editar precios, foto y compatibilidad.');
      }
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['accref:' + operationHash(identity)]);
      const duplicate = await repo.findOne({ where: identity });
      if (duplicate && duplicate.id !== id) throw new ConflictException({ message: 'La referencia ya existe.', id: duplicate.id });
      return repo.save({ ...data, ...identity });
    });
  }
  async deactivateReference(id: number) { return this.updateReference(id, { activo: false }); }

  async ingreso(dto: IngresoAccesorioDto) {
    if (Boolean(dto.referenciaId) === Boolean(dto.referencia)) throw new BadRequestException('Indica referenciaId o los datos de una referencia nueva.');
    if (dto.moneda === 'USD' && !(Number(dto.tipoCambioCompra) > 0)) throw new BadRequestException('Falta el tipo de cambio de compra.');
    return this.ds.transaction(async (em) => {
      await lockAccessoryTopology(em);
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['accingreso:' + dto.idempotencyKey]);
      const receipts = em.getRepository(AccesorioIngreso);
      const hash = operationHash(dto);
      const previous = await receipts.findOneBy({ idempotencyKey: dto.idempotencyKey });
      if (previous) {
        if (previous.operationHash !== hash) throw new ConflictException('La clave del ingreso ya se utilizó con otros datos.');
        return previous.resultado;
      }
      const refs = em.getRepository(AccesorioReferencia);
      const reference = dto.referenciaId ? await refs.findOne({ where: { id: dto.referenciaId }, lock: { mode: 'pessimistic_write' } }) : await this.createReference(dto.referencia!, em);
      if (!reference?.activo) throw new BadRequestException('Referencia no encontrada o inactiva.');
      const products = this.products.conManager(em);
      const productRepo = em.getRepository(Producto);
      const created: number[] = [];
      for (const line of dto.lineas) {
        const lot = await products.create({ tipo: 'accesorios', estado: reference.estado, referenciaId: reference.id, vendedor: dto.comprador,
          soloInventario: dto.tipo === 'local', cantidad: line.cantidad,
          detalle: { modelo: reference.modelo, gama: reference.categoria, generacion: reference.generacion, descripcionOtro: reference.variante,
            modelosCompatibles: reference.compatibilidad ? [reference.compatibilidad] : [] },
          valor: { valorProducto: +(line.costoUnitario * line.cantidad).toFixed(2), valorDec: 0, peso: 0, fechaCompra: dto.fechaCompra,
            costoEnvio: 0, monedaCompra: dto.moneda, tipoCambioCompra: dto.moneda === 'USD' ? dto.tipoCambioCompra : undefined } });
        created.push(lot.id);
        if (dto.tipo === 'importada') {
          await productRepo.update(lot.id, { origen: 'accesorio_importado' });
          await em.getRepository(Inventario).update({ productoId: lot.id }, { enAlmacen: false });
        }
      }
      if (dto.tipo === 'importada') {
        const group = 'acc-' + operationHash(dto.idempotencyKey).slice(0, 50);
        await productRepo.update({ id: In(created) }, { envioGrupoId: group });
        await products.recalcEnvioGrupo(group, Number(dto.costoLogistica || 0));
      }
      const lotes = await productRepo.find({ where: { id: In(created) }, order: { id: 'ASC' } });
      const result = JSON.parse(JSON.stringify({ referencia: reference, lotes, costoTotalSoles: +lotes.reduce((sum, lot) => sum + Number(lot.valor?.costoTotalProrrateado ?? lot.valor?.costoTotal ?? 0), 0).toFixed(2) }));
      await receipts.save(receipts.create({ idempotencyKey: dto.idempotencyKey, operationHash: hash, resultado: result }));
      return result;
    });
  }

  async operativo() {
    const lots = await this.ds.getRepository(Producto).find({ where: { tipo: 'accesorios' }, relations: ['valor', 'tracking', 'referencia'], order: { id: 'ASC' } });
    const fichas = lots.length ? await this.ds.getRepository(Inventario).find({ where: { productoId: In(lots.map((lot) => lot.id)) } }) : [];
    const groups = new Map<string, Producto[]>();
    for (const lot of lots.filter((row) => !row.archivadoAt && !row.cierreMotivo)) {
      const key = accessoryInventoryIdentity(lot, fichas) + ':' + accessoryOwner(lot.vendedor);
      groups.set(key, [...(groups.get(key) || []), lot]);
    }
    const latest = await this.ds.query(`SELECT DISTINCT ON (p.id)
      p.id::text AS grupo,
      v.id, v."productoId", v."fechaVenta"::text AS "fechaVenta", (v.cantidad-COALESCE(v."cantidadDevuelta",0)) AS cantidad,
      (v."precioVenta"-COALESCE(v."precioDevuelto",0)) AS total,
      (v."precioVenta"-COALESCE(v."precioDevuelto",0))/(v.cantidad-COALESCE(v."cantidadDevuelta",0)) AS "precioUnitario"
      FROM venta v JOIN producto p ON p.id=v."productoId"
      WHERE lower(p.tipo)='accesorios' AND v."estadoComercial" IS DISTINCT FROM 'cancelada' AND v.cantidad>COALESCE(v."cantidadDevuelta",0)
      ORDER BY p.id,
      v."fechaVenta" DESC, v.id DESC`);
    const latestByGroup = new Map<string, any>(latest.map((sale) => [sale.grupo, { ...sale, cantidad: Number(sale.cantidad), total: Number(sale.total), precioUnitario: Number(sale.precioUnitario) }]));
    return [...groups.entries()].map(([key, group]) => {
      const first = group.find((lot) => accessoryAvailable(lot) && lot.stockActual > 0) || group[0];
      const disponible = group.filter(accessoryAvailable).reduce((sum, lot) => sum + Number(lot.stockActual), 0);
      const allocation = disponible > 0 ? allocateAccessory(group, first, 1) : null;
      const last = group.map((lot) => latestByGroup.get(String(lot.id))).filter(Boolean)
        .sort((a, b) => String(b.fechaVenta).localeCompare(String(a.fechaVenta)) || Number(b.id) - Number(a.id))[0] ?? null;
      const prices = resolveAccessoryPrices(first, fichas.filter((ficha) => group.some((lot) => lot.id === ficha.productoId)));
      return { key, referencia: first.referencia ?? null, referenciaId: first.referenciaId ?? null, codigo: first.codigoInventario || first.id,
        comprador: first.vendedor, nombre: [first.referencia?.modelo || first.detalle?.modelo, first.referencia?.variante || first.detalle?.descripcionOtro].filter(Boolean).join(' '),
        compatibilidad: first.referencia?.compatibilidad || first.detalle?.modelosCompatibles?.join(', ') || '', estado: first.referencia?.estado || first.estado,
        originalidad: first.referencia?.originalidad || '', variante: first.referencia?.variante || '', disponible,
        enTransito: group.filter((lot) => lot.referenciaId && lot.origen === 'accesorio_importado' && !accessoryAvailable(lot)).reduce((sum, lot) => sum + Number(lot.stockActual), 0),
        costoProximaUnidad: allocation?.costoTotal ?? null, ...prices,
        codigos: [...new Set(group.map((lot) => Number(lot.codigoInventario || lot.id)))].sort((a, b) => a - b),
        ultimaVenta: last, lotes: group, producto: first };
    });
  }
}
