import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Body, Controller, Post } from '@nestjs/common';
import { VisionOcrDto } from './dto/vision-ocr.dto';
import { OcrService } from './ocr.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ocr')
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  @Roles('admin')
  @Post('vision')
  detectText(@Body() dto: VisionOcrDto) {
    return this.ocrService.detectText(dto);
  }
}
