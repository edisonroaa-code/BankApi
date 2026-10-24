import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marca un endpoint como accesible sin sesion (login y health). Todo lo demas exige JWT y rol. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
