// src/producto/dto/update-producto.dto.ts
export class UpdateProductoDto {
  tipo?: string;      // ← ahora opcional
  estado?: string;    // ← ahora opcional
  conCaja?: boolean;  // ← ya opcional

  detalle?: Partial<{
    gama: string;
    procesador: string;
    generacion: string;
    modelo: string;
    tamaño: string;
    almacenamiento: string;
    ram: string;
    conexion: string;
    descripcionOtro: string;
  }>;

  valor?: {
    valorProducto?: number;
    valorDec?:       number;
    peso?:           number;
    fechaCompra?:    string;
  };
}
