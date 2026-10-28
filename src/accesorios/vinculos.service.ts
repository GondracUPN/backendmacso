import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { AccesorioReferencia } from './accesorio-referencia.entity';
import { AccesorioVinculoAuditoria as Audit, AccesorioVinculoOperacion as Operation, AccesorioVinculoPropuesta as Proposal } from './accesorio-vinculo.entity';
import { AccesoriosService } from './accesorios.service';
import { ReferenciaDto } from './accesorios.dto';
import { AplicarVinculosDto, AjusteVinculoDto, DeshacerVinculosDto } from './vinculos.dto';
import { legacyGroup, proposeAccessory, referenceSignature, snapshotLots } from './vinculos-rules';
import { operationHash } from '../venta/operation-hash';
import { lockAccessoryTopology } from '../venta/accessory-locks';

@Injectable()
export class VinculosService {
  constructor(private readonly ds: DataSource, private readonly references: AccesoriosService) {}

  async generar() {
    return this.ds.transaction(async (em) => {
      await lockAccessoryTopology(em);
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['accesorios:vinculos:generar']);
      const products = await em.getRepository(Producto).find({ where: { tipo: 'accesorios' }, relations: ['detalle'], order: { id: 'ASC' } });
      const refs = await em.getRepository(AccesorioReferencia).find();
      const repo = em.getRepository(Proposal);
      const previous = await repo.find({ order: { id: 'DESC' } });
      const candidates = products.filter((lot) => !lot.referenciaId && !lot.archivadoAt && !lot.cierreMotivo);
      const groups = new Map<string, Producto[]>();
      for (const lot of candidates) groups.set(legacyGroup(lot), [...(groups.get(legacyGroup(lot)) || []), lot]);
      const drafts = [...groups.entries()].map(([grupo, lots]) => {
        const code = Number(lots[0].codigoInventario || lots[0].id);
        const proposal = proposeAccessory(lots, refs, candidates.filter((lot) => Number(lot.codigoInventario || lot.id) === code));
        const snapshot = snapshotLots(lots);
        return { ...proposal, grupo, productoId: lots[0].id, productoIds: lots.map((lot) => lot.id), snapshot,
          snapshotHash: operationHash(snapshot), posibleDuplicado: false };
      });
      for (const draft of drafts) {
        const same = drafts.filter((other) => other.grupo.split(':')[0] !== draft.grupo.split(':')[0]
          && referenceSignature(other.datosReferenciaPropuesta) === referenceSignature(draft.datosReferenciaPropuesta));
        if (same.length) { draft.posibleDuplicado = true; draft.motivo += ' Posible duplicado de otros códigos: ' + [...new Set(same.map((other) => 'ACC-' + other.grupo.split(':')[0]))].join(', ') + '. Revisar por separado; no se fusionan códigos.'; }
      }
      const summary = { nuevas: 0, actualizadas: 0, obsoletas: 0, rechazadasConservadas: 0, grupos: drafts.length };
      for (const old of previous.filter((row) => row.estado === 'pendiente')) {
        const current = drafts.find((row) => row.grupo === old.grupo);
        if (!current || current.snapshotHash !== old.snapshotHash) {
          await repo.update(old.id, { estado: 'obsoleta', resueltoAt: new Date(), motivo: old.motivo + ' Obsoleta: cambió stock, detalle, comprador o pertenencia del grupo, o se archivó.' });
          summary.obsoletas++;
        }
      }
      for (const draft of drafts) {
        const old = previous.find((row) => row.grupo === draft.grupo && row.snapshotHash === draft.snapshotHash && row.estado === 'pendiente');
        const rejected = previous.find((row) => row.grupo === draft.grupo && row.snapshotHash === draft.snapshotHash && row.estado === 'rechazada');
        if (old) { await repo.save(repo.create({ ...old, ...draft })); summary.actualizadas++; }
        else if (rejected) summary.rechazadasConservadas++;
        else { await repo.save(repo.create({ ...draft, estado: 'pendiente' })); summary.nuevas++; }
      }
      return summary;
    });
  }

  async listar(params: { estado?: string; puntuacionMin?: string; q?: string; page?: string }) {
    const page = Math.max(1, Number(params.page) || 1), limit = 50;
    const qb = this.ds.getRepository(Proposal).createQueryBuilder('p');
    if (params.estado !== 'todos') qb.andWhere('p.estado = :estado', { estado: params.estado || 'pendiente' });
    const score = Number(params.puntuacionMin || 0);
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new BadRequestException('Puntuación inválida.');
    qb.andWhere('p.puntuacion >= :score', { score });
    if (params.q?.trim()) qb.andWhere(`concat_ws(' ', p.grupo, p.motivo, p."datosReferenciaPropuesta"::text) ILIKE :q`, { q: '%' + params.q.trim() + '%' });
    const [items, total] = await qb.orderBy('p.puntuacion', 'DESC').addOrderBy('p.id', 'ASC').skip((page - 1) * limit).take(limit).getManyAndCount();
    const ids = [...new Set(items.flatMap((item) => item.productoIds))];
    const lots = ids.length ? await this.ds.getRepository(Producto).find({ where: { id: In(ids) }, relations: ['detalle', 'valor'] }) : [];
    const refIds = [...new Set(items.map((item) => item.referenciaId).filter((id): id is number => id != null))];
    const refs = refIds.length ? await this.ds.getRepository(AccesorioReferencia).find({ where: { id: In(refIds) } }) : [];
    return { items: items.map((item) => ({ ...item, lotes: lots.filter((lot) => item.productoIds.includes(lot.id)), referencia: refs.find((ref) => ref.id === item.referenciaId) || null })), total, page, limit };
  }

  async rechazar(id: number, usuario: string, motivo = '') {
    return this.ds.transaction(async (em) => {
      await lockAccessoryTopology(em);
      const repo = em.getRepository(Proposal);
      const proposal = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!proposal || proposal.estado !== 'pendiente') throw new ConflictException('La propuesta ya no está pendiente.');
      await repo.update(id, { estado: 'rechazada', resueltoAt: new Date(), resueltoPor: usuario,
        motivo: proposal.motivo + (motivo ? ' Rechazada por el administrador: ' + motivo : '') });
      return { id, estado: 'rechazada' };
    });
  }

  private async receipt(em: EntityManager, accion: string, key: string, data: unknown) {
    await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['accvinculo:' + accion + ':' + key]);
    const repo = em.getRepository(Operation), hash = operationHash(data);
    const previous = await repo.findOneBy({ accion, idempotencyKey: key });
    if (previous && previous.operationHash !== hash) throw new ConflictException('La clave ya se utilizó con otros datos.');
    return { repo, hash, previous };
  }

  async aplicar(dto: AplicarVinculosDto, usuario: string) {
    const ids = [...new Set(dto.propuestaIds)].sort((a, b) => a - b);
    if (dto.ajustes?.some((row) => !ids.includes(row.propuestaId)) || new Set(dto.ajustes?.map((row) => row.propuestaId)).size !== (dto.ajustes?.length || 0)) throw new BadRequestException('Ajustes de propuestas inválidos.');
    return this.ds.transaction(async (em) => {
      await lockAccessoryTopology(em, true);
      const receipt = await this.receipt(em, 'aplicar', dto.idempotencyKey, { ...dto, parcial: Boolean(dto.parcial), propuestaIds: ids, ajustes: [...(dto.ajustes || [])].sort((a, b) => a.propuestaId - b.propuestaId) });
      if (receipt.previous) return receipt.previous.resultado;
      // Guard against inserts into legacy codes while rows are being regrouped.
      await em.query('LOCK TABLE producto IN SHARE ROW EXCLUSIVE MODE');
      const proposals = await em.getRepository(Proposal).find({ where: { id: In(ids) }, order: { id: 'ASC' } });
      const codes = [...new Set(proposals.flatMap((row) => row.snapshot.map((lot) => Number(lot.codigoInventario || lot.id))))];
      const targets = [...new Set([...proposals.map((row) => row.referenciaId), ...(dto.ajustes || []).map((row) => row.referenciaId)].filter((id): id is number => id != null))];
      await em.query(`SELECT id FROM producto WHERE lower(tipo)='accesorios' AND (COALESCE("codigoInventario",id)=ANY($1::int[]) OR "referenciaId"=ANY($2::int[])) ORDER BY id ASC FOR UPDATE`, [codes, targets]);
      const result: { aplicadas: any[]; fallos: any[] } = { aplicadas: [], fallos: [] };
      for (const id of ids) {
        try {
          const applied = await em.transaction((scoped) => this.applyOne(scoped, proposals.find((row) => row.id === id), (dto.ajustes || []).find((row) => row.propuestaId === id), usuario));
          result.aplicadas.push(applied);
        } catch (error) {
          if (![400, 404, 409].includes(error.getStatus?.())) throw error;
          const failure = { propuestaId: id, motivo: error.message };
          if (!dto.parcial) throw new ConflictException({ message: 'No se aplicó ninguna propuesta. ' + failure.motivo, fallos: [failure] });
          result.fallos.push(failure);
          const stale = proposals.find((row) => row.id === id);
          if (stale?.estado === 'pendiente' && /cambió|archivad|vinculad|composición/.test(failure.motivo)) await em.getRepository(Proposal).update(id, { estado: 'obsoleta', resueltoAt: new Date(), resueltoPor: usuario, motivo: stale.motivo + ' ' + failure.motivo });
        }
      }
      await receipt.repo.save(receipt.repo.create({ accion: 'aplicar', idempotencyKey: dto.idempotencyKey, operationHash: receipt.hash, resultado: result }));
      return result;
    });
  }

  private async applyOne(em: EntityManager, proposal: Proposal | undefined, ajuste: AjusteVinculoDto | undefined, usuario: string) {
    if (!proposal) throw new NotFoundException('Propuesta no encontrada.');
    if (proposal.estado !== 'pendiente') throw new ConflictException('La propuesta ya no está pendiente.');
    const productRepo = em.getRepository(Producto);
    const all = await productRepo.find({ where: { tipo: 'accesorios' }, relations: ['detalle'] });
    const current = all.filter((lot) => !lot.referenciaId && !lot.archivadoAt && !lot.cierreMotivo && legacyGroup(lot) === proposal.grupo);
    if (operationHash(snapshotLots(current)) !== proposal.snapshotHash) throw new ConflictException('El lote o la composición del grupo cambió desde la propuesta: stock, detalle, comprador, archivo o vínculo. Regenera y revisa.');
    if (ajuste?.referenciaId && ajuste.datosReferencia) throw new BadRequestException('Elige referencia existente o datos nuevos, no ambos.');
    let referenciaId = ajuste?.referenciaId ?? (ajuste?.datosReferencia ? null : proposal.referenciaId);
    if (!referenciaId) {
      const data = plainToInstance(ReferenciaDto, ajuste?.datosReferencia || proposal.datosReferenciaPropuesta);
      const errors = await validate(data, { whitelist: true, forbidNonWhitelisted: true });
      if (errors.length) throw new BadRequestException('Completa o corrige los datos de la referencia: ' + errors.map((error) => Object.values(error.constraints || {}).join(', ')).join('; '));
      try { referenciaId = (await this.references.createReference(data, em)).id; }
      catch (error) {
        const existing = error instanceof ConflictException ? (error.getResponse() as any)?.id : null;
        if (!existing) throw error;
        referenciaId = Number(existing);
      }
    }
    const reference = await em.getRepository(AccesorioReferencia).findOne({ where: { id: referenciaId! }, lock: { mode: 'pessimistic_write' } });
    if (!reference?.activo) throw new BadRequestException('Referencia inexistente o inactiva.');
    await em.query('SELECT id FROM producto WHERE "referenciaId"=$1 ORDER BY id ASC FOR UPDATE', [reference.id]);
    const productIds = current.map((lot) => lot.id).sort((a, b) => a - b);
    // Deliberately never save a Producto entity: no cascades into value/history.
    await productRepo.update({ id: In(productIds) }, { referenciaId: reference.id });
    const audits = em.getRepository(Audit);
    const saved = await audits.save(productIds.map((productoId) => audits.create({ productoId, referenciaIdAnterior: null,
      referenciaIdNuevo: reference.id, accion: 'vincular', loteId: proposal.id, usuario })));
    await em.getRepository(Proposal).update(proposal.id, { estado: 'aceptada', referenciaId: reference.id, resueltoAt: new Date(), resueltoPor: usuario });
    return { propuestaId: proposal.id, referenciaId: reference.id, productoIds: productIds, auditoriaIds: saved.map((row) => row.id) };
  }

  async auditoria(params: { productoId?: string; page?: string }) {
    const page = Math.max(1, Number(params.page) || 1), limit = 100;
    const qb = this.ds.getRepository(Audit).createQueryBuilder('a');
    if (params.productoId) qb.where('a.productoId = :id', { id: Number(params.productoId) });
    const [items, total] = await qb.orderBy('a.id', 'DESC').skip((page - 1) * limit).take(limit).getManyAndCount();
    const ids = items.map((row) => row.id), productIds = [...new Set(items.map((row) => row.productoId))];
    const reversals = ids.length ? await this.ds.getRepository(Audit).find({ where: { revierteAuditoriaId: In(ids) } }) : [];
    const all = productIds.length ? await this.ds.getRepository(Audit).find({ where: { productoId: In(productIds) }, order: { id: 'DESC' } }) : [];
    return { items: items.map((row) => ({ ...row, deshecha: reversals.some((item) => item.revierteAuditoriaId === row.id),
      puedeDeshacer: !row.revierteAuditoriaId && row.accion === 'vincular' && all.find((item) => item.productoId === row.productoId)?.id === row.id && !reversals.some((item) => item.revierteAuditoriaId === row.id) })), total, page, limit };
  }

  async deshacer(dto: DeshacerVinculosDto, usuario: string) {
    if (Boolean(dto.productoIds?.length) === Boolean(dto.auditoriaIds?.length)) throw new BadRequestException('Indica productoIds o auditoriaIds, no ambos.');
    return this.ds.transaction(async (em) => {
      await lockAccessoryTopology(em, true);
      const receipt = dto.idempotencyKey ? await this.receipt(em, 'deshacer', dto.idempotencyKey, dto) : null;
      if (receipt?.previous) return receipt.previous.resultado;
      await em.query('LOCK TABLE producto IN SHARE ROW EXCLUSIVE MODE');
      const auditRepo = em.getRepository(Audit);
      const selected = await auditRepo.find({ where: dto.auditoriaIds ? { id: In(dto.auditoriaIds) } : { productoId: In(dto.productoIds!) }, order: { id: 'DESC' } });
      const sources = dto.auditoriaIds ? selected : dto.productoIds!.map((id) => selected.find((row) => row.productoId === id)).filter((row): row is Audit => Boolean(row));
      if (sources.length !== (dto.auditoriaIds || dto.productoIds)!.length || new Set(sources.map((row) => row.productoId)).size !== sources.length) throw new ConflictException('No se encontró un vínculo único para cada lote.');
      await em.query('SELECT id FROM producto WHERE id=ANY($1::int[]) OR "referenciaId"=ANY($2::int[]) ORDER BY id ASC FOR UPDATE', [sources.map((row) => row.productoId), sources.flatMap((row) => [row.referenciaIdAnterior, row.referenciaIdNuevo]).filter((id) => id != null)]);
      const result: { deshechas: number[]; yaDeshechas: number[] } = { deshechas: [], yaDeshechas: [] };
      for (const source of sources.sort((a, b) => a.productoId - b.productoId)) {
        const reverted = await auditRepo.findOneBy({ revierteAuditoriaId: source.id });
        if (reverted) { result.yaDeshechas.push(source.id); continue; }
        const latest = await auditRepo.findOne({ where: { productoId: source.productoId }, order: { id: 'DESC' } });
        const lot = await em.getRepository(Producto).findOneBy({ id: source.productoId });
        if (source.revierteAuditoriaId || source.accion !== 'vincular' || latest?.id !== source.id || !lot || (lot.referenciaId ?? null) !== source.referenciaIdNuevo) throw new ConflictException('El vínculo del lote cambió; no se puede deshacer una versión antigua.');
        await em.getRepository(Producto).update(source.productoId, { referenciaId: source.referenciaIdAnterior });
        await auditRepo.save(auditRepo.create({ productoId: source.productoId, referenciaIdAnterior: source.referenciaIdNuevo,
          referenciaIdNuevo: source.referenciaIdAnterior, accion: source.referenciaIdAnterior == null ? 'desvincular' : 'vincular',
          loteId: source.loteId, revierteAuditoriaId: source.id, usuario }));
        result.deshechas.push(source.id);
      }
      if (receipt) await receipt.repo.save(receipt.repo.create({ accion: 'deshacer', idempotencyKey: dto.idempotencyKey!, operationHash: receipt.hash, resultado: result }));
      return result;
    });
  }

  async cambioInformativo(id: number, rate: number) {
    return this.ds.transaction(async (em) => {
      const lot = await em.getRepository(Producto).findOne({ where: { id }, relations: ['valor'] });
      if (!lot || lot.tipo.toLowerCase() !== 'accesorios' || !lot.valor) throw new NotFoundException('Lote de accesorio no encontrado.');
      if (lot.valor.monedaCompra !== 'USD') throw new BadRequestException('El dato informativo solo corresponde a compras USD.');
      const updated = await em.getRepository(ProductoValor).update({ id: lot.valor.id, tipoCambioCompra: IsNull() }, { tipoCambioCompra: rate });
      if (!updated.affected) throw new ConflictException('El lote ya tiene un tipo de cambio registrado.');
      return { productoId: id, tipoCambioCompra: rate, cambioImplicito: Number(lot.valor.valorProducto) > 0 ? Number(lot.valor.valorSoles) / Number(lot.valor.valorProducto) : null };
    });
  }
}
