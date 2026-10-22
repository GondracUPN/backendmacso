import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class CatalogEventGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = String(process.env.CATALOG_SYNC_SECRET || '').trim();
    const received = context.switchToHttp().getRequest().headers['x-sync-secret'];
    const actual = typeof received === 'string' ? received : '';
    const a = Buffer.from(actual); const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Credencial de catálogo inválida.');
    }
    return true;
  }
}
