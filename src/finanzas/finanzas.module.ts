import { Module } from '@nestjs/common';
import { FinanzasCoreModule } from './finanzas-core.module';
import { VentaModule } from '../venta/venta.module';
import { FinanzasService } from './finanzas.service';
import { FinanzasAnalisisService } from './finanzas-analisis.service';
import { FinanzasController } from './finanzas.controller';

@Module({
  imports: [FinanzasCoreModule, VentaModule],
  providers: [FinanzasService, FinanzasAnalisisService],
  controllers: [FinanzasController],
})
export class FinanzasModule {}
