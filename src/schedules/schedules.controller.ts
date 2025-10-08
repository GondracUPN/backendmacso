import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { SchedulesService } from './schedules.service';
import { CreateScheduledDto } from './dto/create-scheduled.dto';
import { UpdateScheduledDto } from './dto/update-scheduled.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser, JwtUserPayload } from '../auth/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('schedules')
export class SchedulesController {
  constructor(private readonly svc: SchedulesService) {}

  @Get()
  list(@CurrentUser() user: JwtUserPayload) {
    return this.svc.findAllByUser(user.userId);
  }

  @Post()
  create(@CurrentUser() user: JwtUserPayload, @Body() dto: CreateScheduledDto) {
    return this.svc.create(user.userId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateScheduledDto,
  ) {
    return this.svc.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: JwtUserPayload, @Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(user.userId, id);
  }

  // Ejecuta generación de gastos para programaciones vencidas (del usuario)
  @Post('process')
  process(@CurrentUser() user: JwtUserPayload) {
    return this.svc.processDue(user.userId);
  }
}

