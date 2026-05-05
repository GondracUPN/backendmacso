import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

@Injectable()
export class CatalogService {
  constructor(@InjectRepository(CatalogItem) private readonly repo: Repository<CatalogItem>) {}

  listProductOptions() {
    return this.repo.find({
      where: { kind: 'product_option', active: true },
      order: { productType: 'ASC', family: 'ASC', value: 'ASC', id: 'ASC' },
    });
  }

  listExpenseConcepts() {
    return this.repo.find({
      where: { kind: 'expense_concept', active: true },
      order: { label: 'ASC', id: 'ASC' },
    });
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

  async createExpenseConcept(dto: any) {
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
      metadata: {
        defaultCurrency: dto?.defaultCurrency === 'USD' ? 'USD' : 'PEN',
      },
    });
    return this.repo.save(item);
  }

  async isExpenseConceptAllowed(concept: string, method: 'debito' | 'credito') {
    const value = normalizeValue(concept);
    if (!value) return false;
    const item = await this.repo.findOne({
      where: { kind: 'expense_concept', value, active: true },
    });
    if (!item) return false;
    return method === 'debito' ? item.appliesDebit : item.appliesCredit;
  }

  async disable(id: number) {
    const item = await this.repo.findOne({ where: { id } });
    if (!item) throw new NotFoundException('Item no encontrado.');
    item.active = false;
    return this.repo.save(item);
  }
}
