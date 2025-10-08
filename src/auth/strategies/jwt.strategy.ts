import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtUserPayload } from '../decorators/current-user.decorator';

type RawJwt = {
  sub?: number; // normalmente viene sub
  userId?: number; // por si en algún entorno lo firmaron así
  username: string;
  role: 'admin' | 'user';
  iat?: number;
  exp?: number;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(cfg: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: cfg.get<string>('JWT_SECRET'),
    });
  }

  // Lo que retornes aquí se asigna a req.user
  validate(payload: RawJwt): JwtUserPayload {
    // Normaliza a userId; acepta sub o userId en el token
    const userId =
      typeof payload.userId === 'number'
        ? payload.userId
        : typeof payload.sub === 'number'
          ? payload.sub
          : Number(payload.userId ?? payload.sub ?? 0);

    return {
      userId,
      sub: typeof payload.sub === 'number' ? payload.sub : userId, // opcional
      username: payload.username,
      role: payload.role,
      iat: payload.iat,
      exp: payload.exp,
    };
  }
}
