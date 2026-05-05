import { Body, Controller, Post } from '@nestjs/common';
import { VisionOcrDto } from './dto/vision-ocr.dto';
import { OcrService } from './ocr.service';

@Controller('ocr')
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  @Post('vision')
  detectText(@Body() dto: VisionOcrDto) {
    return this.ocrService.detectText(dto);
  }
}
