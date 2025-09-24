// src/cards/cards.controller.ts
import { Controller, Get, Post, Patch, Body, Query, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { CardsService } from './cards.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('cards')
export class CardsController {
  constructor(private readonly svc: CardsService) {}

  @Get()
  async list(@CurrentUser() user: JwtUserPayload, @Query('userId') userId?: string) {
    const uid = user.role === 'admin' && userId ? Number(userId) : user.userId;
    return this.svc.findAllByUser(uid);
  }

  @Get('summary')
  async mySummary(@CurrentUser() user: JwtUserPayload) {
    return this.svc.getSummary(user.userId);
  }

  @Roles('admin')
  @Get('summary-by-user')
  async summaryByUser(@Query('userId') userId: string) {
    return this.svc.getSummary(Number(userId));
  }

  @Post()
  async create(
    @CurrentUser() user: JwtUserPayload,
    @Body() body: { tipo: string; creditLine: number; userId?: number }, // 👈 userId opcional
  ) {
    const uid = user.role === 'admin' && body.userId ? Number(body.userId) : user.userId; // 👈 crea para ese user si eres admin
    return this.svc.create(uid, body.tipo, Number(body.creditLine));
  }

  @Patch(':id')
  async patch(
    @CurrentUser() user: JwtUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { creditLine: number },
  ) {
    return this.svc.update(user.userId, user.role, id, Number(body.creditLine));
  }
}
