import { desgloseVentaConAccesorios } from './reparto-venta-equipo';

const venta = {
  productoId: 1, precioVenta: 10.01, costoPendiente: false, costoDevuelto: 0, precioDevuelto: 0,
  distribucionStock: [
    { productoId: 1, cantidad: 1, costoUnitario: 4 },
    { productoId: 2, nombre: 'Cable', cantidad: 1, costoUnitario: 4 },
    { productoId: 3, nombre: 'Cubo', cantidad: 1, costoUnitario: 4 },
  ],
};

it('reparte el céntimo sobrante sin alterar la suma y recalcula la pérdida al cambiar el importe', () => {
  expect(desgloseVentaConAccesorios(venta).map(({ ingreso, ganancia }) => [ingreso, ganancia]))
    .toEqual([[3.34, -0.66], [3.34, -0.66], [3.33, -0.67]]);
  expect(desgloseVentaConAccesorios({ ...venta, precioVenta: 24 }).map(({ ingreso, ganancia }) => [ingreso, ganancia]))
    .toEqual([[8, 4], [8, 4], [8, 4]]);
});

it('deja pendiente el reparto completo si falta algún costo', () => {
  const distribucionStock = venta.distribucionStock.map((parte) => parte.productoId === 3 ? { ...parte, costoUnitario: undefined } : parte);
  expect(desgloseVentaConAccesorios({ ...venta, distribucionStock }).map(({ ingreso, costo, ganancia }) => [ingreso, costo, ganancia]))
    .toEqual([[null, 4, null], [null, 4, null], [null, null, null]]);
});
