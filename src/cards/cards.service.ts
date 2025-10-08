import { Injectable, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Card } from './card.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { Role } from '../auth/entities/user.entity';
import { ConfigService } from '@nestjs/config';

const CREDIT_CONCEPTS = ['comida', 'gusto', 'inversion', 'pago_envios'];

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

  getCardTypes() {
    return [
      { tipo: 'interbank', label: 'Interbank' },
      { tipo: 'bcp_amex', label: 'BCP Amex' },
      { tipo: 'bcp_visa', label: 'BCP Visa' },
      { tipo: 'bbva', label: 'BBVA' },
      { tipo: 'io', label: 'IO' },
      { tipo: 'saga', label: 'Saga' },
    ];
  }

  async create(
    userId: number,
    tipo: string,
    creditLine: number,
    opts?: { creditLinePen?: number; creditLineUsd?: number },
  ) {
    const c = this.repo.create({
      userId,
      tipo,
      creditLine: (Number(creditLine) || 0).toFixed(2),
      creditLinePen:
        opts?.creditLinePen != null ? (Number(opts.creditLinePen) || 0).toFixed(2) : null,
      creditLineUsd:
        opts?.creditLineUsd != null ? (Number(opts.creditLineUsd) || 0).toFixed(2) : null,
    });
    return this.repo.save(c);
  }

  async update(
    userId: number,
    role: Role,
    id: number,
    creditLine: number,
    opts?: { creditLinePen?: number; creditLineUsd?: number },
  ) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) return null;
    if (role !== 'admin' && c.userId !== userId) {
      throw new ForbiddenException('No autorizado');
    }
    c.creditLine = (Number(creditLine) || 0).toFixed(2);
    if (opts?.creditLinePen !== undefined)
      c.creditLinePen = (Number(opts.creditLinePen) || 0).toFixed(2);
    if (opts?.creditLineUsd !== undefined)
      c.creditLineUsd = (Number(opts.creditLineUsd) || 0).toFixed(2);
    return this.repo.save(c);
  }

  async remove(userId: number, role: Role, id: number) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) return null;
    if (role !== 'admin' && c.userId !== userId) {
      throw new ForbiddenException('No autorizado');
    }
    await this.repo.remove(c);
    return { ok: true };
  }

  // Resumen por tarjeta en S/
  async getSummary(userId: number) {
    const cards = await this.findAllByUser(userId);
    if (!cards.length) return [];

    const gastos = await this.gastosRepo
      .createQueryBuilder('g')
      .select([
        'g.id',
        'g.concepto',
        'g.metodoPago',
        'g.moneda',
        'g.monto',
        'g.fecha',
        'g.tarjeta',
        'g.tarjetaPago',
        'g.pagoObjetivo',
        'g.montoUsdAplicado',
        'g.tasaUsdPen',
      ])
      .where('g.userId = :uid', { uid: userId })
      .andWhere(
        `(
          (g.metodoPago = 'credito' AND g.tarjeta IS NOT NULL AND (LOWER(g.concepto) IN (:...cons) OR LOWER(g.concepto) = 'ingreso'))
          OR
          (g.metodoPago = 'debito' AND LOWER(g.concepto) = 'pago_tarjeta' AND g.tarjetaPago IS NOT NULL)
        )`,
        { cons: CREDIT_CONCEPTS },
      )
      .orderBy('g.fecha', 'ASC')
      .getMany();

    const USD_PEN_RATE = 3.7;

    const usedPen = new Map<string, number>();
    const usedUsd = new Map<string, number>();
    const addPen = (k: string, v: number) => usedPen.set(k, (usedPen.get(k) || 0) + v);
    const addUsd = (k: string, v: number) => usedUsd.set(k, (usedUsd.get(k) || 0) + v);

    for (const g of gastos) {
      const c = String(g.concepto || '').toLowerCase();
      if (g.metodoPago === 'credito') {
        if (CREDIT_CONCEPTS.includes(c)) addUsd(g.tarjeta!, Number(g.monto || 0));
        else if (c === 'ingreso') addUsd(g.tarjeta!, -Number(g.monto || 0));
        continue;
      }
      if (g.metodoPago === 'debito' && c === 'pago_tarjeta') {
        const key = g.tarjetaPago!;
        const go: any = g as any;
        const tc = (() => {
          const t = Number(go.tasaUsdPen);
          if (isFinite(t) && t > 0) return t;
          const musd = Number(go.montoUsdAplicado);
          const m = Number(g.monto);
          if (isFinite(musd) && musd > 0) {
            const t2 = m / musd;
            if (isFinite(t2) && t2 > 0) return t2;
          }
          return USD_PEN_RATE;
        })();
        const curUsd = Number(usedUsd.get(key) || 0);
        const explicitUSD = go.pagoObjetivo === 'USD';
        const explicitPEN = go.pagoObjetivo === 'PEN';
        const targetUsd = explicitUSD || go.montoUsdAplicado != null || g.moneda === 'USD' || (!explicitPEN && curUsd > 0);

        if (targetUsd) {
          const usdPay = g.moneda === 'USD' ? Number(g.monto) : Number(g.monto) / tc;
          const usdApplied = Math.min(curUsd, usdPay);
          addUsd(key, -usdApplied);
          if (g.moneda === 'PEN') {
            const penUsedForUsd = usdApplied * tc;
            const penLeft = Number(g.monto) - penUsedForUsd;
            if (penLeft > 0.0001) addPen(key, -penLeft);
          }
        } else {
          const penPay = g.moneda === 'PEN' ? Number(g.monto) : Number(g.monto) * tc;
          addPen(key, -penPay);
        }
      }
    }

    return cards.map((c) => {
      const lineLegacy = Number(c.creditLine || 0);
      const linePen = Number(c.creditLinePen || 0);
      const lineUsd = Number(c.creditLineUsd || 0);
      const line = lineLegacy > 0 ? lineLegacy : linePen + lineUsd * USD_PEN_RATE;
      const used = Math.max(0, Number(usedPen.get(c.tipo) || 0) + Number(usedUsd.get(c.tipo) || 0) * USD_PEN_RATE);
      const available = Math.max(0, line - used);
      return { id: c.id, tipo: c.tipo, creditLine: +line.toFixed(2), used: +used.toFixed(2), available: +available.toFixed(2) };
    });
  }
}

