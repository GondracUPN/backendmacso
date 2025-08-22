export class CreateProductoDto {
  tipo: string;
  estado: string;
  conCaja?: boolean;

  detalle?: {
    gama?: string;
    procesador?: string;
    generacion?: string;
    modelo?: string;
    tamaño?: string;
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
