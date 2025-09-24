// src/gastos/gastos.controller.ts
import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { GastosService } from './gastos.service';
import { CreateGastoDto } from './dto/create-gasto.dto';
import { UpdateGastoDto } from './dto/update-gasto.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('gastos')
export class GastosController {
  constructor(private readonly svc: GastosService) {}

  // Cualquier usuario: sus propios gastos
  @Get()
  findMine(@CurrentUser() user: JwtUserPayload) {
    return this.svc.findAllByUser(user.userId); // <-- usar user.userId
  }

  // ADMIN: ver todos, o filtrar por ?userId=#
  @Roles('admin')
  @Get('all')
  findAll(@Query('userId') userId?: string) {
    if (userId) return this.svc.findAllByUser(Number(userId));
    return this.svc.findAll();
  }

  @Post()
  create(@CurrentUser() user: JwtUserPayload, @Body() dto: CreateGastoDto) {
    return this.svc.create(user.userId, dto); // <-- usar user.userId
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGastoDto,
  ) {
    return this.svc.update(user.userId, user.role, id, dto); // <-- usar user.userId
  }

  @Delete(':id')
  remove(@CurrentUser() user: JwtUserPayload, @Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(user.userId, user.role, id); // <-- usar user.userId
  }
}
