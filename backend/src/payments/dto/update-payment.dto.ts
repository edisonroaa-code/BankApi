import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * Campos que un cobrador puede corregir en un pago PENDIENTE. Mismos limites que
 * CreatePaymentDto; no exige campos no vacios porque al editar el formulario solo
 * valida el monto y existen registros historicos incompletos.
 */
export class UpdatePaymentDto {
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  paymentRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  sourceBank?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  clientCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  clientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  observation?: string;

  /** Permite clasificar históricos desconocidos; nunca acepta volver a NULL por API. */
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  isAtlasAccount?: boolean;
}
