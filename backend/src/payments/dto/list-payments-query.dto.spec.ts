import { ValidationPipe } from '@nestjs/common';
import { ListPaymentsQueryDto } from './list-payments-query.dto';

const parse = (value: Record<string, unknown>) =>
  new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
    .transform(value, { type: 'query', metatype: ListPaymentsQueryDto }) as Promise<ListPaymentsQueryDto>;

describe('ListPaymentsQueryDto Atlas filter', () => {
  it('accepts an explicit true or false query value', async () => {
    await expect(parse({ isAtlasAccount: 'true' })).resolves.toMatchObject({ isAtlasAccount: true });
    await expect(parse({ isAtlasAccount: 'false' })).resolves.toMatchObject({ isAtlasAccount: false });
  });

  it('rejects ambiguous values instead of silently filtering the wrong account', async () => {
    await expect(parse({ isAtlasAccount: 'yes' })).rejects.toThrow();
    await expect(parse({ isAtlasAccount: '' })).rejects.toThrow();
  });
});
