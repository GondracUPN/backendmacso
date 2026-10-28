import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { VisionOcrDto } from './dto/vision-ocr.dto';
import { OcrService } from './ocr.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ocr')
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  @Roles('admin')
  @Post('vision')
  detectText(@Body() dto: VisionOcrDto, @Res({ passthrough: true }) res: Response) {
    // Si el cliente cancela o cierra la conexión, se dejan de lanzar llamadas a Vision.
    const controller = new AbortController();
    res.on?.('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    return this.ocrService.detectText(dto, controller.signal);
  }
}
