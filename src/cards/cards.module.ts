// src/cards/cards.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CardsService } from './cards.service';
import { CardsController } from './cards.controller';
import { Card } from './card.entity';
import { Gasto } from '../gastos/entities/gasto.entity'; // 👈

@Module({
  imports: [TypeOrmModule.forFeature([Card, Gasto])], // 👈 incluye Gasto
  controllers: [CardsController],
  providers: [CardsService],
  exports: [CardsService],
})
export class CardsModule {}
