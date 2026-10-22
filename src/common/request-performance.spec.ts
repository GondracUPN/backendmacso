import { PerformanceSqlLogger, requestPerformance } from './request-performance';

describe('contador SQL por peticion', () => {
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
