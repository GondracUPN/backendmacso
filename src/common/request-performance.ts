import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { CallHandler, ExecutionContext, Logger, NestInterceptor } from '@nestjs/common';
import { AdvancedConsoleLogger, QueryRunner } from 'typeorm';
import { Observable, tap } from 'rxjs';

export const requestPerformance = new AsyncLocalStorage<{ queries: number }>();

export class PerformanceSqlLogger extends AdvancedConsoleLogger {
  logQuery(query: string, parameters?: any[], queryRunner?: QueryRunner) {
    const counter = requestPerformance.getStore();
    if (counter) counter.queries += 1;
    super.logQuery(query, parameters, queryRunner);
  }
}

export class RequestPerformanceInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Performance');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (process.env.PERF_LOG === 'false') return next.handle();
    const response = context.switchToHttp().getResponse();
    const request = context.switchToHttp().getRequest();
    return new Observable((subscriber) => {
      const counter = { queries: 0 };
      const started = performance.now();
      let recorded = false;
      const record = () => {
        if (recorded) return;
        recorded = true;
        const duration = performance.now() - started;
        if (!response.headersSent) {
          response.setHeader('Server-Timing', `app;dur=${duration.toFixed(1)}, db;desc="${counter.queries} queries"`);
        }
        if (duration > 500 || counter.queries > 20) {
          this.logger.warn({ method: request.method, route: request.route?.path || request.path,
            durationMs: Math.round(duration), queries: counter.queries });
        }
      };
      return requestPerformance.run(counter, () => next.handle().pipe(
        tap({ next: record, error: record, complete: record }),
      ).subscribe(subscriber));
    });
  }
}
