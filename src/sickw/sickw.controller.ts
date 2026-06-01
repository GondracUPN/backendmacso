import { Body, Controller, Get, Post } from '@nestjs/common';
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
}
