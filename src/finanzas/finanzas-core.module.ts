import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CuentaFinanciera } from './entities/cuenta-financiera.entity';
import { VentaPago } from './entities/venta-pago.entity';
import { PagoLiquidacion } from './entities/pago-liquidacion.entity';
import { MovimientoFinanciero } from './entities/movimiento-financiero.entity';
import { Reembolso } from './entities/reembolso.entity';
import { ReembolsoEvento } from './entities/reembolso-evento.entity';
import { FinanzasLedgerService } from './finanzas-ledger.service';

/** Libro de pagos: lo usa Ventas sin depender del módulo de análisis. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CuentaFinanciera,
      VentaPago,
      PagoLiquidacion,
      MovimientoFinanciero,
      Reembolso,
      ReembolsoEvento,
    ]),
  ],
  providers: [FinanzasLedgerService],
  exports: [FinanzasLedgerService, TypeOrmModule],
})
export class FinanzasCoreModule {}
