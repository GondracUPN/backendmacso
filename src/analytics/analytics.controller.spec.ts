import { ForbiddenException } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

describe('finance seller scope', () => {
  const financialDashboard = jest.fn(async (params) => params);
  const controller = new AnalyticsController({ financialDashboard } as unknown as AnalyticsService);

  it('restringe a un usuario normal a su vendedor', async () => {
    await controller.finance(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'Gonzalo', undefined, undefined, { userId: 2, username: 'renato', role: 'user' });
    expect(financialDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ vendedor: 'Renato' }));
  });

  it('permite vista general al administrador', async () => {
    await controller.finance(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { userId: 1, username: 'admin', role: 'admin' });
    expect(financialDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ vendedor: undefined }));
  });

  it('no expone el resumen general a cuentas sin vendedor reconocible', async () => {
    await expect(controller.finance(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { userId: 3, username: 'other', role: 'user' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
