import { ValidationPipe } from '@nestjs/common';
import { CreatePaymentDto } from './create-payment.dto';

const valid = {
  amount: 1000,
  clientCode: 'CLIENTE-1',
  paymentRef: 'REF-1',
  sourceBank: 'BANCO',
  isAtlasAccount: true,
};

describe('CreatePaymentDto', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const parse = (value: Record<string, unknown>) => pipe.transform(value, { type: 'body', metatype: CreatePaymentDto });

  it('rechaza estado impuesto por el cliente', async () => {
    await expect(parse({ ...valid, status: 'CONFIRMADO' })).rejects.toThrow();
  });

  it('rechaza URL/base64 de comprobante impuesta por el cliente', async () => {
    await expect(parse({ ...valid, proofUrl: 'data:text/html,<script>alert(1)</script>' })).rejects.toThrow();
  });

  it('acepta únicamente los datos de la consulta', async () => {
    await expect(parse(valid)).resolves.toMatchObject(valid);
  });

  it('exige clasificar explícitamente la cuenta receptora', async () => {
    const { isAtlasAccount: _classification, ...unclassified } = valid;
    await expect(parse(unclassified)).rejects.toThrow();
  });

  it('interpreta false del formulario sin convertirlo en true', async () => {
    await expect(parse({ ...valid, isAtlasAccount: 'false' })).resolves.toMatchObject({ isAtlasAccount: false });
    await expect(parse({ ...valid, isAtlasAccount: 'true' })).resolves.toMatchObject({ isAtlasAccount: true });
    await expect(parse({ ...valid, isAtlasAccount: 'no' })).rejects.toThrow();
  });

  it('acepta solo consultas en guaranies y normaliza el codigo ISO', async () => {
    await expect(parse({ ...valid, currency: ' pyg ' })).resolves.toMatchObject({ currency: 'PYG' });
    await expect(parse({ ...valid, currency: 'USD' })).rejects.toThrow();
    await expect(parse({ ...valid, currency: 'Gs' })).rejects.toThrow();
    await expect(parse({ ...valid, currency: null })).rejects.toThrow();
  });
});
