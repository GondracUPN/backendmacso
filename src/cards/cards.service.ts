import { Injectable, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Card } from './card.entity';
import { Repository } from 'typeorm';
import { Role } from '../auth/entities/user.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { ConfigService } from '@nestjs/config';

const CREDIT_CONCEPTS = ['comida','gusto','inversion','pago_envios'];

@Injectable()
export class CardsService {
  constructor(
    @InjectRepository(Card) private readonly repo: Repository<Card>,
    @InjectRepository(Gasto) private readonly gastosRepo: Repository<Gasto>,
    private readonly cfg: ConfigService,
  ) {}

  findMine(userId: number) {
    return this.repo.find({ where: { userId }, order: { id: 'ASC' } });
  }

  findAllByUser(userId: number) {
    return this.findMine(userId);
  }

  async create(userId: number, tipo: string, creditLine: number) {
    const c = this.repo.create({
      userId,
      tipo,
      creditLine: (Number(creditLine) || 0).toFixed(2),
    });
    return this.repo.save(c);
  }

  async update(userId: number, role: Role, id: number, creditLine: number) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) return null;
    if (role !== 'admin' && c.userId !== userId) {
      throw new ForbiddenException('No autorizado');
    }
    c.creditLine = (Number(creditLine) || 0).toFixed(2);
    return this.repo.save(c);
  }

  /**
   * Resumen por tarjeta (S/):
   * used = (consumos en crédito: comida|gusto|inversion|pago_envios, PEN+USD→PEN)
   *      - (pagos desde débito concepto pago_tarjeta → tarjetaPago)
   *      - (ingresos hechos en crédito)
   * available = creditLine - used
   * Tasa USD→PEN = env GASTOS_USD_RATE (default 3.8)
   */
  async getSummary(userId: number) {
    const cards = await this.findAllByUser(userId);
    if (!cards.length) return [];

    const usd = Number(this.cfg.get('GASTOS_USD_RATE') ?? 3.8);

    // Consumos en crédito (solo conceptos específicos)
    const consumoCred = await this.gastosRepo
      .createQueryBuilder('g')
      .select('g.tarjeta', 'tarjeta')
      .addSelect(
        `COALESCE(SUM(
          CASE WHEN g.moneda = 'USD' THEN CAST(g.monto AS numeric) * :usd ELSE CAST(g.monto AS numeric) END
        ), 0)`,
        'sum',
      )
      .where('g.userId = :uid', { uid: userId })
      .andWhere('g.metodoPago = :mp', { mp: 'credito' })
      .andWhere('g.tarjeta IS NOT NULL')
      .andWhere('LOWER(g.concepto) IN (:...cons)', { cons: CREDIT_CONCEPTS })
      .groupBy('g.tarjeta')
      .setParameters({ usd })
      .getRawMany<{ tarjeta: string; sum: string }>();

    // Pagos de tarjeta hechos desde DÉBITO (concepto = pago_tarjeta) → restan
    const pagosDebito = await this.gastosRepo
      .createQueryBuilder('g')
      .select('g.tarjetaPago', 'tarjeta')
      .addSelect(
        `COALESCE(SUM(
          CASE WHEN g.moneda = 'USD' THEN CAST(g.monto AS numeric) * :usd ELSE CAST(g.monto AS numeric) END
        ), 0)`,
        'sum',
      )
      .where('g.userId = :uid', { uid: userId })
      .andWhere('g.metodoPago = :mp', { mp: 'debito' })
      .andWhere('LOWER(g.concepto) = :pt', { pt: 'pago_tarjeta' })
      .andWhere('g.tarjetaPago IS NOT NULL')
      .groupBy('g.tarjetaPago')
      .setParameters({ usd })
      .getRawMany<{ tarjeta: string; sum: string }>();

    // Ingresos en crédito → restan
    const ingresosCred = await this.gastosRepo
      .createQueryBuilder('g')
      .select('g.tarjeta', 'tarjeta')
      .addSelect(
        `COALESCE(SUM(
          CASE WHEN g.moneda = 'USD' THEN CAST(g.monto AS numeric) * :usd ELSE CAST(g.monto AS numeric) END
        ), 0)`,
        'sum',
      )
      .where('g.userId = :uid', { uid: userId })
      .andWhere('g.metodoPago = :mp', { mp: 'credito' })
      .andWhere('g.tarjeta IS NOT NULL')
      .andWhere('LOWER(g.concepto) = :ing', { ing: 'ingreso' })
      .groupBy('g.tarjeta')
      .setParameters({ usd })
      .getRawMany<{ tarjeta: string; sum: string }>();

    const usedMap = new Map<string, number>();

    for (const r of consumoCred) {
      if (!r.tarjeta) continue;
      usedMap.set(r.tarjeta, (usedMap.get(r.tarjeta) || 0) + Number(r.sum || 0));
    }
    for (const r of pagosDebito) {
      if (!r.tarjeta) continue;
      usedMap.set(r.tarjeta, (usedMap.get(r.tarjeta) || 0) - Number(r.sum || 0));
    }
    for (const r of ingresosCred) {
      if (!r.tarjeta) continue;
      usedMap.set(r.tarjeta, (usedMap.get(r.tarjeta) || 0) - Number(r.sum || 0));
    }

    return cards.map(c => {
      const line = Number(c.creditLine || 0);
      const used = Math.max(0, Number(usedMap.get(c.tipo) || 0));
      const available = Math.max(0, line - used);
      return {
        id: c.id,
        tipo: c.tipo,
        creditLine: +line.toFixed(2),
        used: +used.toFixed(2),
        available: +available.toFixed(2),
      };
    });
  }
}
