export class CreateProductoDto {
  tipo: string;
  estado: string;
  conCaja?: boolean;

  detalle?: {
    gama?: string;
    procesador?: string;
    generacion?: string;
    modelo?: string;
    tamanio?: string;
    almacenamiento?: string;
    ram?: string;
    conexion?: string;
    descripcionOtro?: string;
  };

  valor?: {
    valorProducto: number;
    valorDec: number;
    peso: number;
    fechaCompra: string;
  };
}
