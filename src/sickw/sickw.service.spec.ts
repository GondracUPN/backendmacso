import { SickwService } from './sickw.service';

describe('SickwService - formato iFreeiCloud', () => {
  const service = new SickwService({} as any, {} as any);

  it('prioriza identificadores, elimina duplicados y colorea estados de riesgo', () => {
    const fields = (service as any).parseIfreeIcloudFields({
      object: {
        thumbnail: 'https://example.com/device.jpg',
        model_desc: 'IPHONE 17 PRO MAX CORANGE 256GB-USA',
        imei: '359253624165025',
        imei2: '359253624021822',
        serial: 'DLXTN47WM0',
        est_purchase_date: '2026-08-14',
        purchase_country: 'United States',
        repair_coverage: true,
        replaced: false,
        replacement: true,
        refurbished: false,
        loaner: false,
        fmi_on: true,
        lost_mode: false,
        usa_block_status: 'Clean',
        sim_lock: true,
        apple: {
          region: 'United States',
          model_name: 'iPhone 17 Pro Max',
        },
        is_apple_device: true,
      },
    }, 'Coverage Status: Apple Limited Warranty');

    expect(fields.slice(0, 7).map((field: any) => field.label)).toEqual([
      'Producto',
      'Modelo',
      'Número de serie',
      'IMEI',
      'IMEI 2',
      'Fecha estimada de compra',
      'Find My',
    ]);
    expect(fields.find((field: any) => field.label === 'Fecha estimada de compra')?.value)
      .toBe('14 de agosto de 2026');
    expect(fields.find((field: any) => field.label === 'Find My')).toMatchObject({ value: 'ON', tone: 'bad' });
    expect(fields.find((field: any) => field.label === 'SIM Lock')).toMatchObject({ value: 'Locked', tone: 'bad' });
    expect(fields.find((field: any) => field.label === 'Dispositivo de reemplazo')).toMatchObject({ value: 'Sí', tone: 'bad' });
    expect(fields.find((field: any) => field.label === 'Reemplazado por Apple')).toMatchObject({ value: 'No', tone: 'good' });
    expect(fields.filter((field: any) => /serial|número de serie/i.test(field.label))).toHaveLength(1);
    expect(fields.filter((field: any) => field.label === 'País de compra')).toHaveLength(1);
    expect(fields.some((field: any) => /thumbnail|image/i.test(field.label))).toBe(false);
  });
});
