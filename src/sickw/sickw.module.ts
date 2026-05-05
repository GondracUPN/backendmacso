import { Module } from '@nestjs/common';
import { SickwController } from './sickw.controller';
import { SickwService } from './sickw.service';

@Module({
  controllers: [SickwController],
  providers: [SickwService],
})
export class SickwModule {}
