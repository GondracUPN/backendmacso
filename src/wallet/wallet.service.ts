import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Wallet } from './wallet.entity';
import { Repository } from 'typeorm';

@Injectable()
export class WalletService {
  constructor(@InjectRepository(Wallet) private readonly repo: Repository<Wallet>) {}

  async getOrCreate(userId: number) {
    let w = await this.repo.findOne({ where: { userId } });
    if (!w) {
      w = this.repo.create({ userId, efectivoPen: '0', efectivoUsd: '0' });
      w = await this.repo.save(w);
    }
    return w;
  }

  async upsert(userId: number, pen: number, usd: number) {
    const w = await this.getOrCreate(userId);
    w.efectivoPen = (Number(pen) || 0).toFixed(2);
    w.efectivoUsd = (Number(usd) || 0).toFixed(2);
    return this.repo.save(w);
  }
}
