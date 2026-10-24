import { ValidationPipe } from '@nestjs/common';
import { UpdatePaymentDto } from './update-payment.dto';

describe('UpdatePaymentDto', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const parse = (value: Record<string, unknown>) => pipe.transform(value, { type: 'body', metatype: UpdatePaymentDto });

  it('permite clasificar un histórico desde un formulario sin coerción de false a true', async () => {
    await expect(parse({ isAtlasAccount: 'false' })).resolves.toMatchObject({ isAtlasAccount: false });
    await expect(parse({ isAtlasAccount: 'true' })).resolves.toMatchObject({ isAtlasAccount: true });
  });

  it('admite omitir el campo pero no volver a desconocido ni aceptar texto ambiguo', async () => {
    await expect(parse({})).resolves.toMatchObject({});
    await expect(parse({ isAtlasAccount: null })).rejects.toThrow();
    await expect(parse({ isAtlasAccount: 'otro' })).rejects.toThrow();
  });
});
