import { PerformanceSqlLogger, requestPerformance, RequestPerformanceInterceptor } from './request-performance';
import { defer, lastValueFrom, of } from 'rxjs';

describe('contador SQL por peticion', () => {
  it('publica el contador en Server-Timing antes de enviar la respuesta', async () => {
    const response = { setHeader: jest.fn(), headersSent: false };
    const context: any = { switchToHttp: () => ({ getResponse: () => response,
      getRequest: () => ({ method: 'GET', path: '/productos' }) }) };
    const sql = new PerformanceSqlLogger(false);
    const interceptor = new RequestPerformanceInterceptor();
    await lastValueFrom(interceptor.intercept(context, { handle: () => defer(() => {
      sql.logQuery('SELECT 1'); sql.logQuery('SELECT 2'); return of([]);
    }) }));
    expect(response.setHeader).toHaveBeenCalledWith('Server-Timing', expect.stringMatching(/^app;dur=\d+\.\d, db;desc="2 queries"$/));
  });
  it('aisla peticiones concurrentes e ignora consultas fuera de una peticion', async () => {
    const logger = new PerformanceSqlLogger(false);
    logger.logQuery('SELECT 0');
    const counts = await Promise.all([1, 3].map((total) =>
      requestPerformance.run({ queries: 0 }, async () => {
        for (let i = 0; i < total; i++) {
          await Promise.resolve();
          logger.logQuery('SELECT 1');
        }
        return requestPerformance.getStore()!.queries;
      }),
    ));
    expect(counts).toEqual([1, 3]);
    expect(requestPerformance.getStore()).toBeUndefined();
  });
});
