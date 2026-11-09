import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { CatalogItem } from './catalog-item.entity';

const normalizeValue = (value: string) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const splitValues = (value: unknown) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const normalizeExpenseCategory = (value: unknown) => {
  const category = String(value || '').trim().toLowerCase();
  return ['life', 'income', 'investment', 'shipping', 'debt', 'card_payment', 'other'].includes(category)
    ? category
    : 'life';
};

@Injectable()
export class CatalogService {
  constructor(@InjectRepository(CatalogItem) private readonly repo: Repository<CatalogItem>) {}

  listProductOptions() {
    return this.repo.find({
      where: { kind: 'product_option', active: true },
      order: { productType: 'ASC', family: 'ASC', value: 'ASC', id: 'ASC' },
    });
  }

  /** Conceptos compartidos (sin dueño) más los creados por el usuario; los de otros usuarios no se ven. */
  listExpenseConcepts(userId?: number | null) {
    const owners = userId ? [{ ownerUserId: IsNull() }, { ownerUserId: userId }] : [{ ownerUserId: IsNull() }];
    return this.repo.find({
      where: owners.map((owner) => ({ kind: 'expense_concept' as const, active: true, ...owner })),
      order: { label: 'ASC', id: 'ASC' },
    });
  }

  async listAll(userId?: number | null) {
    const [productOptions, expenseConcepts] = await Promise.all([
      this.listProductOptions(),
      this.listExpenseConcepts(userId),
    ]);
    return { productOptions, expenseConcepts };
  }

  async createProductOption(dto: any) {
    const productType = String(dto?.productType || '').trim().toLowerCase();
    const family = String(dto?.family || '').trim();
    const value = String(dto?.value || '').trim();
    const label = String(dto?.label || value || family).trim();
    if (!['macbook', 'ipad', 'iphone'].includes(productType)) {
      throw new BadRequestException('Tipo de producto invalido.');
    }
    if (!family) throw new BadRequestException('Ingresa linea, gama o numero.');
    if (productType !== 'iphone' && !value) throw new BadRequestException('Ingresa procesador o generacion.');

    const item = this.repo.create({
      kind: 'product_option',
      productType,
      family,
      value: value || family,
      label,
      active: true,
      metadata: {
        sizes: splitValues(dto?.sizes),
        rams: splitValues(dto?.rams),
        storages: splitValues(dto?.storages),
        models: splitValues(dto?.models),
      },
    });
    return this.repo.save(item);
  }

  async createExpenseConcept(dto: any, userId: number) {
    const label = String(dto?.label || '').trim();
    const value = normalizeValue(dto?.value || label);
    const appliesDebit = Boolean(dto?.appliesDebit);
    const appliesCredit = Boolean(dto?.appliesCredit);
    if (!label || !value) throw new BadRequestException('Ingresa el concepto.');
    if (!appliesDebit && !appliesCredit) {
      throw new BadRequestException('Selecciona debito, credito o ambos.');
    }

    const item = this.repo.create({
      kind: 'expense_concept',
      value,
      label,
      appliesDebit,
      appliesCredit,
      active: true,
      ownerUserId: userId,
      metadata: {
        defaultCurrency: dto?.defaultCurrency === 'USD' ? 'USD' : 'PEN',
        category: normalizeExpenseCategory(dto?.category),
      },
    });
    return this.repo.save(item);
  }

  /** userId es el dueño del gasto: solo valen sus conceptos y los compartidos. */
  async isExpenseConceptAllowed(concept: string, method: 'debito' | 'credito', userId?: number | null) {
    const value = normalizeValue(concept);
    if (!value) return false;
    const items = await this.repo.find({
      where: [
        { kind: 'expense_concept', value, active: true, ownerUserId: IsNull() },
        ...(userId ? [{ kind: 'expense_concept' as const, value, active: true, ownerUserId: userId }] : []),
      ],
    });
    return items.some((item) => (method === 'debito' ? item.appliesDebit : item.appliesCredit));
  }

  async disable(id: number, userId?: number | null) {
    // Solo opciones y conceptos: las filas del catálogo Apple se gestionan desde /apple-catalog.
    const item = await this.repo.findOne({ where: { id, kind: In(['product_option', 'expense_concept']) } });
    // Un concepto privado de otro usuario se trata como inexistente.
    if (!item || (item.ownerUserId != null && item.ownerUserId !== userId)) throw new NotFoundException('Item no encontrado.');
    item.active = false;
    return this.repo.save(item);
  }
}
