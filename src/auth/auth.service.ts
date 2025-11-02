// src/auth/auth.service.ts
import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Repository, ILike } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { User, Role } from './entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  // Login insensible a mayúsculas + trim
  async login(dto: LoginDto) {
    const username = (dto.username ?? '').trim();
    const password = dto.password ?? '';

    const user = await this.usersRepo.findOne({
      where: { username: ILike(username) },
    });

    if (!user) {
      throw new UnauthorizedException('Usuario o contraseña incorrectos.');
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Usuario o contraseña incorrectos.');
    }

    const access_token = await this.signToken(user);
    return {
      access_token, // 👈 IMPORTANTÍSIMO
      user: { id: user.id, username: user.username, role: user.role },
    };
  }

  /** Solo Admin crea usuarios */
  async register(dto: RegisterDto) {
    const username = (dto.username ?? '').trim();

    const exists = await this.usersRepo.findOne({
      where: { username: ILike(username) },
    });
    if (exists) throw new BadRequestException('El usuario ya existe.');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const role: Role =
      dto.role === 'admin' || dto.role === 'user' ? dto.role : 'user';

    const user = this.usersRepo.create({ username, passwordHash, role });
    const saved = await this.usersRepo.save(user);

    return { id: saved.id, username: saved.username, role: saved.role };
  }

  async listUsers(): Promise<Array<Pick<User, 'id' | 'username' | 'role'>>> {
    return this.usersRepo.find({ select: ['id', 'username', 'role'] });
  }

  async updateUser(id: number, dto: UpdateUserDto) {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new BadRequestException('Usuario no encontrado');

    if (dto.role) {
      user.role = dto.role;
    }
    if (dto.password) {
      user.passwordHash = await bcrypt.hash(dto.password, 10);
    }
    if (dto.username) {
      const exists = await this.usersRepo.findOne({ where: { username: ILike(dto.username) } });
      if (exists && exists.id !== id) {
        throw new BadRequestException('El usuario ya existe.');
      }
      user.username = dto.username.trim();
    }

    const saved = await this.usersRepo.save(user);
    return { id: saved.id, username: saved.username, role: saved.role };
  }

  async deleteUser(id: number) {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new BadRequestException('Usuario no encontrado');
    await this.usersRepo.remove(user);
    return { ok: true };
  }

  private async signToken(user: User): Promise<string> {
    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
    };
    return this.jwt.signAsync(payload);
  }
}
