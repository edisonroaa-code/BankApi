import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ClaimReferenceType } from '../entities/bank-transfer-claim.entity';
import { BankTransferStatus } from '../entities/bank-transfer.entity';
import { PrintConfirmationDto, PrintPreviewDto } from '../../payments/dto/print.dto';

export class BankPrintPreviewDto extends PrintPreviewDto {
  @IsUUID()
  claimId: string;
}

export class BankPrintConfirmationDto extends PrintConfirmationDto {
  @IsUUID()
  claimId: string;
}

export class ListBankTransfersQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date debe tener formato YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsEnum(BankTransferStatus)
  status?: BankTransferStatus;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}

/** Panel por mes, paginado. */
export class ListBankTransfersPageQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month debe tener formato YYYY-MM' })
  month?: string;

  @IsOptional()
  @IsIn(['DISPONIBLES', 'TOMADAS', 'REVISAR', 'TODAS'])
  view?: 'DISPONIBLES' | 'TOMADAS' | 'REVISAR' | 'TODAS';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}

export class ClaimBankTransferDto {
  @IsIn([ClaimReferenceType.TICKET, ClaimReferenceType.CLIENTE])
  referenceType: ClaimReferenceType.TICKET | ClaimReferenceType.CLIENTE;

  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  referenceValue: string;

  @IsUUID()
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  /** Toma parcial: si no viene, se toma todo el saldo libre (el caso normal). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  /** El usuario ya vio el aviso de referencia repetida y confirma que es otra parte del mismo cobro. */
  @IsOptional()
  @IsBoolean()
  confirmReuse?: boolean;
}

export class ReasonDto {
  @IsString()
  @MinLength(10)
  @MaxLength(300)
  reason: string;
}

/** La anulación siempre apunta a una toma concreta; un reintento viejo no debe anular otra. */
export class VoidBankTransferClaimDto extends ReasonDto {
  @IsUUID()
  claimId: string;
}

export class ClaimIdDto {
  @IsOptional()
  @IsUUID()
  claimId?: string;
}

/** Marcar revisada apunta a una conciliacion concreta. */
export class ReviewClaimDto {
  @IsUUID()
  claimId: string;
}

export class ReconcileBankTransferDto {
  @IsUUID()
  paymentId: string;

  @IsUUID()
  idempotencyKey: string;

  /** Parte del monto a aplicar a esa consulta. Por defecto, lo que alcance de los dos saldos. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;
}

export class MatchesQueryDto {
  @IsUUID()
  paymentId: string;
}

export class MyClaimsQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date debe tener formato YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month debe tener formato YYYY-MM' })
  month?: string;
}

export class ReviewQueueQueryDto {
  /** Cuantos dias hacia atras se revisan. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  days?: number;

  /** Solo las conciliaciones sin evidencia. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  onlyWeak?: boolean;
}
