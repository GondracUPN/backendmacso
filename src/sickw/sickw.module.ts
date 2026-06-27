import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SickwController } from './sickw.controller';
import { SickwService } from './sickw.service';
import { SickwCheckHistory } from './sickw-check-history.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SickwCheckHistory])],
  controllers: [SickwController],
  providers: [SickwService],
})
export class SickwModule {}
