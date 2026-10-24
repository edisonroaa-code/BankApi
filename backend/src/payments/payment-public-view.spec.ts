import { paymentPublicView } from './payment-public-view';

describe('paymentPublicView', () => {
  it('replaces a legacy public URL with the protected API route without mutating storage state', () => {
    const stored = { id: 'payment-1', proofUrl: 'https://res.cloudinary.com/cloud/image/upload/old.jpg' };
    const view = paymentPublicView(stored);
    expect(view).toMatchObject({ id: 'payment-1', proofUrl: '/payments/payment-1/proof', hasProof: true });
    expect(stored.proofUrl).toContain('res.cloudinary.com');
  });

  it('preserves the redacted foreign-payment view', () => {
    const stored = { id: 'payment-2', hasProof: true };
    expect(paymentPublicView(stored)).toEqual(stored);
  });
});
