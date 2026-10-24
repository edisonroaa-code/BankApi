import { PaymentsController } from './payments.controller';
import { PaymentState } from './entities/payment.entity';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

describe('PaymentsController realtime targets', () => {
  const makeController = () => {
    const paymentsService = {
      create: jest.fn(),
      reject: jest.fn(),
      findOne: jest.fn(),
      logProofViewed: jest.fn(),
    };
    const storageService = {
      saveFile: jest.fn(),
      readFile: jest.fn(),
      deleteNewFile: jest.fn(),
    };
    const paymentsGateway = {
      emitPaymentsChanged: jest.fn(),
    };

    const controller = new PaymentsController(paymentsService as any, storageService as any, paymentsGateway as any);
    return { controller, paymentsService, paymentsGateway, storageService };
  };

  it('targets the creator when a transfer is created', async () => {
    const { controller, paymentsService, paymentsGateway } = makeController();
    paymentsService.create.mockResolvedValue({
      id: 'payment-1',
      createdById: 'collector-1',
      status: PaymentState.PENDIENTE_VERIFICACION,
    });

    await controller.create({ amount: 1000 } as any, {
      buffer: Buffer.from('%PDF-1.7\n'), size: 9, mimetype: 'application/pdf',
    } as Express.Multer.File, {
      user: { userId: 'collector-1', username: 'cobrador1', name: 'Cobrador 1' },
    });

    expect(paymentsGateway.emitPaymentsChanged).toHaveBeenCalledWith({
      type: 'PAYMENT_CREATED',
      paymentId: 'payment-1',
      targetUserId: 'collector-1',
    });
  });

  it('requires a real uploaded proof before creating a payment', async () => {
    const { controller, paymentsService } = makeController();
    await expect(controller.create({ amount: 1000 } as any, undefined as any, {
      user: { userId: 'collector-1' },
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(paymentsService.create).not.toHaveBeenCalled();
  });

  it('targets the creator when a transfer is rejected', async () => {
    const { controller, paymentsService, paymentsGateway } = makeController();
    paymentsService.reject.mockResolvedValue({
      id: 'payment-1',
      createdById: 'collector-1',
      status: PaymentState.RECHAZADO,
    });

    await controller.reject('payment-1', { reason: 'Datos no coinciden' }, {
      user: { userId: 'supervisor-1', username: 'supervisor1', name: 'Supervisor 1' },
    });

    expect(paymentsGateway.emitPaymentsChanged).toHaveBeenCalledWith({
      type: 'PAYMENT_REJECTED',
      paymentId: 'payment-1',
      targetUserId: 'collector-1',
    });
  });

  it('never serializes a stored Cloudinary URL in a payment response', async () => {
    const { controller, paymentsService } = makeController();
    paymentsService.findOne.mockResolvedValue({ id: 'payment-1', proofUrl: 'https://res.cloudinary.com/secret/image/upload/old.jpg' });
    const payment = await controller.getOne('payment-1', { user: { userId: 'admin-1', role: 'ADMIN' } });
    expect(payment?.proofUrl).toBe('/payments/payment-1/proof');
  });

  it('denies the proof when the collector receives a redacted foreign payment', async () => {
    const { controller, paymentsService, storageService } = makeController();
    paymentsService.findOne.mockResolvedValue({ id: 'payment-1', hasProof: true });
    await expect(controller.getProof('payment-1', { user: { userId: 'collector-2', role: 'COBRADOR' } }, {} as any))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(storageService.readFile).not.toHaveBeenCalled();
  });

  it('serves a proof through the authorized API with no-store and no sniffing', async () => {
    const { controller, paymentsService, storageService } = makeController();
    paymentsService.findOne.mockResolvedValue({ id: 'payment-1', proofUrl: 'cld-auth-raw:transferencias/id.pdf' });
    storageService.readFile.mockResolvedValue({ buffer: Buffer.from('%PDF-1.7\n'), mimeType: 'application/pdf', extension: '.pdf' });
    const response = { setHeader: jest.fn(), end: jest.fn() };
    await controller.getProof('payment-1', { user: { userId: 'admin-1', role: 'ADMIN' } }, response as any);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(response.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(response.end).toHaveBeenCalledWith(Buffer.from('%PDF-1.7\n'));
  });

  it('keeps the cached-PWA proof-viewed endpoint without fabricating an audit event', async () => {
    const { controller, paymentsService } = makeController();
    expect(await controller.proofViewed('payment-1')).toEqual({ ok: true, deprecated: true });
    expect(paymentsService.logProofViewed).not.toHaveBeenCalled();
  });

  it('compensates an upload when persisting the payment fails', async () => {
    const { controller, paymentsService, storageService } = makeController();
    storageService.saveFile.mockResolvedValue('cld-auth-raw:transferencias/id.pdf');
    paymentsService.create.mockRejectedValue(new Error('DB unavailable'));
    await expect(controller.create({ amount: 1000 } as any, {
      buffer: Buffer.from('%PDF-1.7\n'), size: 9, mimetype: 'application/pdf',
    } as Express.Multer.File, { user: { userId: 'collector-1', username: 'collector' } }))
      .rejects.toThrow('DB unavailable');
    expect(storageService.deleteNewFile).toHaveBeenCalledWith('cld-auth-raw:transferencias/id.pdf');
  });
});
