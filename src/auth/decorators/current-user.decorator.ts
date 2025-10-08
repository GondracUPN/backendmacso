import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Payload que exponemos en req.user (normalizado) */
export type JwtUserPayload = {
  userId: number; // 👈 SIEMPRE presente
  sub?: number; // compatibilidad (opcional)
  username: string;
  role: 'admin' | 'user';
  iat?: number;
  exp?: number;
};

/** Extrae y normaliza req.user a { userId, username, role, ... } */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtUserPayload => {
    const req = ctx.switchToHttp().getRequest();
    const u = req.user || {};

    // Normaliza: preferimos userId; si no viene, usamos sub
    const userId =
      typeof u.userId === 'number'
        ? u.userId
        : typeof u.sub === 'number'
          ? u.sub
          : Number(u.userId ?? u.sub ?? 0);

    return {
      userId,
      sub: typeof u.sub === 'number' ? u.sub : userId, // opcional, por compatibilidad
      username: u.username,
      role: u.role,
      iat: u.iat,
      exp: u.exp,
    };
  },
);
