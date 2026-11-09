import { NotFoundException } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { CatalogService } from './catalog.service';

const repoMock = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  create: jest.fn((value) => value),
  save: jest.fn(async (value) => value),
});

describe('CatalogService: conceptos de gasto por usuario', () => {
  it('lista los conceptos compartidos y los del usuario, nunca los de otro', async () => {
    const repo = repoMock();
    await new CatalogService(repo as any).listExpenseConcepts(7);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          { kind: 'expense_concept', active: true, ownerUserId: IsNull() },
          { kind: 'expense_concept', active: true, ownerUserId: 7 },
        ],
      }),
    );
  });

  it('sin usuario solo devuelve los compartidos', async () => {
    const repo = repoMock();
    await new CatalogService(repo as any).listExpenseConcepts();
    expect(repo.find.mock.calls[0][0].where).toEqual([
      { kind: 'expense_concept', active: true, ownerUserId: IsNull() },
    ]);
  });

  it('el concepto creado pertenece a quien lo crea; las opciones de producto siguen siendo generales', async () => {
    const repo = repoMock();
    const svc = new CatalogService(repo as any);
    const concepto = await svc.createExpenseConcept(
      { label: 'Gimnasio', appliesDebit: true },
      7,
    );
    expect(concepto).toMatchObject({
      kind: 'expense_concept',
      value: 'gimnasio',
      ownerUserId: 7,
    });
    const opcion = await svc.createProductOption({
      productType: 'ipad',
      family: 'Air',
      value: 'M2',
    });
    expect(opcion.ownerUserId).toBeUndefined();
  });

  it('valida el gasto solo con conceptos compartidos o del dueño del gasto', async () => {
    const repo = repoMock();
    repo.find.mockResolvedValue([{ appliesDebit: true, appliesCredit: false }]);
    const svc = new CatalogService(repo as any);
    await expect(
      svc.isExpenseConceptAllowed('Gimnasio', 'debito', 7),
    ).resolves.toBe(true);
    expect(repo.find.mock.calls[0][0].where).toEqual([
      {
        kind: 'expense_concept',
        value: 'gimnasio',
        active: true,
        ownerUserId: IsNull(),
      },
      {
        kind: 'expense_concept',
        value: 'gimnasio',
        active: true,
        ownerUserId: 7,
      },
    ]);
    repo.find.mockResolvedValue([]);
    await expect(
      svc.isExpenseConceptAllowed('Gimnasio', 'debito', 8),
    ).resolves.toBe(false);
  });

  it('no permite desactivar el concepto privado de otro usuario', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue({
      id: 3,
      kind: 'expense_concept',
      ownerUserId: 7,
      active: true,
    });
    const svc = new CatalogService(repo as any);
    await expect(svc.disable(3, 8)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.save).not.toHaveBeenCalled();
    await expect(svc.disable(3, 7)).resolves.toMatchObject({ active: false });
  });
});
