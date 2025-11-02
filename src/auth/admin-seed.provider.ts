import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';

@Injectable()
export class AdminSeedProvider implements OnModuleInit {
  private readonly logger = new Logger(AdminSeedProvider.name);

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly cfg: ConfigService,
  ) {}

  async onModuleInit() {
    const env = this.cfg.get<string>('NODE_ENV') || process.env.NODE_ENV || 'development';
    const enabled = (this.cfg.get<string>('SEED_ADMIN') ?? (env !== 'production' ? 'true' : 'false')) === 'true';
    if (!enabled) return;

    const adminUser = this.cfg.get<string>('SEED_ADMIN_USERNAME') || 'admin';
    const adminPass = this.cfg.get<string>('SEED_ADMIN_PASSWORD') || 'Wggl-2001';

    const count = await this.usersRepo.count();
    if (count > 0) return;

    const passwordHash = await bcrypt.hash(adminPass, 10);
    const user = this.usersRepo.create({ username: adminUser, passwordHash, role: 'admin' });
    await this.usersRepo.save(user);
    this.logger.log(`Admin seed creado: ${adminUser}`);
  }
}

