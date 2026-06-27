import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SickwCheckDto } from './dto/sickw-check.dto';
import { SickwService } from './sickw.service';

@Controller('sickw')
export class SickwController {
  constructor(private readonly sickwService: SickwService) {}

  @Post('apple-basic-info')
  appleBasicInfo(@Body() dto: SickwCheckDto) {
    return this.sickwService.appleBasicInfo(dto.identifier, dto.type, dto.serviceId);
  }

  @Get('balance')
  balance() {
    return this.sickwService.balance();
  }

  @Get('history')
  history(
    @Query('query') query?: string,
    @Query('limit') limit?: string,
    @Query('serviceId') serviceId?: string,
  ) {
    return this.sickwService.history(query, limit, serviceId);
  }

  @Get('history/status')
  historyStatus(
    @Query('identifier') identifier: string,
    @Query('type') type?: string,
    @Query('serviceId') serviceId?: string,
  ) {
    return this.sickwService.historyStatus(identifier, type, serviceId);
  }
}
