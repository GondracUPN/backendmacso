import { Controller, Get, Put, Body, Query, UseGuards } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly svc: WalletService) {}

  @Get()
  async get(@CurrentUser() user: JwtUserPayload, @Query('userId') userId?: string) {
    const uid = user.role === 'admin' && userId ? Number(userId) : user.userId;
    return this.svc.getOrCreate(uid);
  }

  @Put()
  async put(
    @CurrentUser() user: JwtUserPayload,
    @Body() body: { efectivoPen?: number; efectivoUsd?: number },
  ) {
    const pen = Number(body?.efectivoPen ?? 0);
    const usd = Number(body?.efectivoUsd ?? 0);
    return this.svc.upsert(user.userId, pen, usd);
  }
}
