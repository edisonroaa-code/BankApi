import { BadRequestException, Controller, ForbiddenException, Get, Logger, NotFoundException, Patch, Post, Body, Request, Response as ResDecorator, UploadedFile, UseInterceptors, Param, Query } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { StorageService } from '../storage/storage.service';
import * as crypto from 'crypto';
import { computeDhash64FromBuffer } from './proof-dhash';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentActionDto } from './dto/payment-action.dto';
import { PrintConfirmationDto, PrintPreviewDto } from './dto/print.dto';
import { SummaryQueryDto } from './dto/summary-query.dto';
import { AuditQueryDto } from './dto/audit-query.dto';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PaymentsGateway } from './payments.gateway';
import { MAX_PROOF_BYTES, shouldComputeProofDhash, validateProofFile } from './proof-file-policy';
import { paymentPublicView } from './payment-public-view';
import type { Response } from 'express';

@Controller('payments')
export class PaymentsController {
    private readonly logger = new Logger(PaymentsController.name);
    constructor(
        private paymentsService: PaymentsService,
        private storageService: StorageService,
        private paymentsGateway: PaymentsGateway,
    ) { }

    @Get()
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    findAll(@Query() query: ListPaymentsQueryDto, @Request() req: any) {
        // Enforce a hard limit to prevent memory crashing on unpaginated clients
        if (!query.limit || Number(query.limit) > 200) {
            query.limit = 150;
        }
        return this.paymentsService.findAll(query, {
            userId: req.user.userId,
            username: req.user.username,
            role: req.user.role,
        });
    }

    @Get('paged')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    findPaged(@Query() query: ListPaymentsQueryDto, @Request() req: any) {
        return this.paymentsService.findAllPaged(query, {
            userId: req.user.userId,
            username: req.user.username,
            role: req.user.role,
        });
    }

    @Get('audit')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR)
    listAudit(@Query() query: AuditQueryDto) {
        return this.paymentsService.listAudit(query);
    }

    @Get(':id/audit')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    getAudit(@Param('id') id: string, @Request() req: any) {
        return this.paymentsService.getAuditForPayment(id, { userId: req.user.userId, role: req.user.role });
    }

    @Get('proof-views')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    listProofViews(@Request() req: any, @Query('limit') limit?: string) {
        const parsed = limit ? parseInt(limit, 10) : undefined;
        return this.paymentsService.listProofViews(parsed ?? 50, { userId: req.user.userId, role: req.user.role });
    }

    @Get('activity')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    listActivity(@Request() req: any, @Query('limit') limit?: string) {
        const parsed = limit ? parseInt(limit, 10) : undefined;
        return this.paymentsService.listActivity(parsed ?? 80, { userId: req.user.userId, role: req.user.role });
    }

    @Post(':id/proof-viewed')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    async proofViewed(@Param('id') _id: string) {
        // Compatibilidad para PWA antiguas cacheadas: la señal del cliente no
        // demuestra que descargó bytes, por lo que no crea un evento de auditoría.
        return { ok: true, deprecated: true };
    }

    @Post()
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    @UseInterceptors(FileInterceptor('file', {
        // Multer >=2.3 entiende fieldArrayIndexLimit; @types/multer aun no lo declara.
        limits: { fileSize: MAX_PROOF_BYTES, files: 1, fields: 8, parts: 9, fieldNameSize: 64, fieldSize: 1024, fieldArrayIndexLimit: 0 },
    } as Parameters<typeof FileInterceptor>[1]))
    async create(@Body() createPaymentDto: CreatePaymentDto, @UploadedFile() file: Express.Multer.File, @Request() req: any) {
        if (!file) throw new BadRequestException('El comprobante es obligatorio.');
        const proofKind = validateProofFile(file);

        let fileHash: string | undefined;
        let proofDhash: string | undefined;

        // Calcular las huellas solo sobre bytes validados, antes del almacenamiento.
        fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

        // Jimp decodifica toda la imagen: limitar tanto bytes como dimensiones.
        if (shouldComputeProofDhash(file, proofKind)) {
            try {
                proofDhash = await computeDhash64FromBuffer(file.buffer);
            } catch {
                // La huella perceptual es auxiliar; el hash exacto se conserva.
            }
        }
        const proofUrl = await this.storageService.saveFile(file);
        let created;
        try {
            created = await this.paymentsService.create(
                { ...createPaymentDto, proofUrl, fileHash, proofDhash },
                { userId: req.user.userId, username: req.user.username, name: req.user.name },
            );
        } catch (error) {
            try {
                await this.storageService.deleteNewFile(proofUrl);
            } catch {
                // La carga quedó huérfana; nunca exponer el identificador ni tapar el error primario.
                this.logger.error(`No se pudo compensar una carga de comprobante tras fallar la creación de la consulta. Referencia opaca: ${proofUrl}`);
            }
            throw error;
        }
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_CREATED', paymentId: created.id, targetUserId: created.createdById });
        return paymentPublicView(created);
    }

    @Get(':id/proof')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    async getProof(@Param('id') id: string, @Request() req: any, @ResDecorator() response: Response) {
        const payment = await this.paymentsService.findOne(id, {
            userId: req.user.userId, username: req.user.username, role: req.user.role,
        });
        if (!payment) throw new NotFoundException('Consulta no encontrada.');
        if (!payment.proofUrl) throw new ForbiddenException('No tenés permiso para ver este comprobante.');
        const proof = await this.storageService.readFile(payment.proofUrl);
        await this.paymentsService.logProofViewed(id, { userId: req.user.userId, username: req.user.username, role: req.user.role });
        response.setHeader('Content-Type', proof.mimeType);
        response.setHeader('Content-Length', proof.buffer.length);
        response.setHeader('Content-Disposition', `inline; filename="comprobante${proof.extension}"`);
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('X-Robots-Tag', 'noindex');
        response.end(proof.buffer);
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_PROOF_VIEWED', paymentId: id });
    }

    @Get('summary')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR)
    getSummary(@Query() query: SummaryQueryDto) {
        return this.paymentsService.getSummary(query.startDate, query.endDate);
    }

    @Get('review-queue')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR)
    async listReviewQueue(@Request() req: any, @Query('limit') limit?: string, @Query('onlyMine') onlyMine?: string) {
        const parsedLimit = limit ? parseInt(limit, 10) : undefined;
        const onlyMineBool = (onlyMine ?? '').toLowerCase() === 'true';
        const payments = await this.paymentsService.listReviewQueue(
            { limit: parsedLimit ?? 80, onlyMine: onlyMineBool },
            { userId: req.user.userId, username: req.user.username, name: req.user.name },
        );
        return payments.map(paymentPublicView);
    }

    @Post(':id/claim-review')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR)
    async claimReview(@Param('id') id: string, @Request() req: any) {
        const res = await this.paymentsService.claimReview(id, { userId: req.user.userId, username: req.user.username, name: req.user.name });
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_REVIEW_CLAIMED', paymentId: id, targetUserId: res.createdById });
        return paymentPublicView(res);
    }

    @Post(':id/release-review')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR)
    async releaseReview(@Param('id') id: string, @Request() req: any) {
        const res = await this.paymentsService.releaseReview(id, { userId: req.user.userId, username: req.user.username, name: req.user.name });
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_REVIEW_RELEASED', paymentId: id, targetUserId: res.createdById });
        return paymentPublicView(res);
    }

    @Get('kpis')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    getKpis(
        @Query('startDate') startDate?: string,
        @Query('endDate') endDate?: string,
        @Query('overdueMinutes') overdueMinutes?: string,
    ) {
        const overdue = overdueMinutes ? parseInt(overdueMinutes, 10) : undefined;
        return this.paymentsService.getKpis({ startDate, endDate, overdueMinutes: overdue });
    }

    @Post(':id/confirm-manual')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR)
    async confirmManual(@Param('id') id: string, @Body() body: PaymentActionDto, @Request() req: any) {
        const res = await this.paymentsService.confirmManual(id, body.reason, { userId: req.user.userId, username: req.user.username, name: req.user.name });
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_CONFIRMED_MANUAL', paymentId: id, targetUserId: res.createdById });
        return paymentPublicView(res);
    }

    @Post(':id/reject')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR)
    async reject(@Param('id') id: string, @Body() body: PaymentActionDto, @Request() req: any) {
        const res = await this.paymentsService.reject(id, body.reason, { userId: req.user.userId, username: req.user.username, name: req.user.name });
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_REJECTED', paymentId: id, targetUserId: res.createdById });
        return paymentPublicView(res);
    }

    @Post(':id/undo-decision')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR)
    async undoDecision(@Param('id') id: string, @Request() req: any) {
        const res = await this.paymentsService.undoDecision(id, {
            userId: req.user.userId,
            username: req.user.username,
            name: req.user.name,
            role: req.user.role,
        });
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_DECISION_UNDONE', paymentId: id, targetUserId: res.createdById });
        return paymentPublicView(res);
    }

    /** Datos del ticket para el dialogo de impresion; no lo cuenta como impreso. */
    @Post(':id/print-preview')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    async openPrintDialog(@Param('id') id: string, @Request() req: any, @Body() body: PrintPreviewDto) {
        const res = await this.paymentsService.openPrintDialog(id, {
            userId: req.user.userId,
            username: req.user.username,
            name: req.user.name,
            role: req.user.role,
        }, body?.reason);
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_TICKET_ISSUED', paymentId: id, targetUserId: res.createdById });
        return paymentPublicView(res);
    }

    /** La persona confirmo que el ticket salio impreso. */
    @Post(':id/print')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    async markAsPrinted(@Param('id') id: string, @Request() req: any, @Body() body: PrintConfirmationDto) {
        const res = await this.paymentsService.markAsPrinted(id, {
            userId: req.user.userId,
            username: req.user.username,
            name: req.user.name,
            role: req.user.role,
        }, body?.authorizationId);
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_PRINTED', paymentId: id, targetUserId: res.createdById });
        return paymentPublicView(res);
    }

    @Post(':id/cash-paid')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    async markCashPaid(@Param('id') id: string, @Request() req: any) {
        const res = await this.paymentsService.markCashPaid(id, {
            userId: req.user.userId,
            username: req.user.username,
            name: req.user.name,
            role: req.user.role,
        });
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_CASH_PAID', paymentId: id, targetUserId: res.createdById });
        return paymentPublicView(res);
    }

    @Get(':id')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    getOne(@Param('id') id: string, @Request() req: any) {
        return this.paymentsService.findOne(id, {
            userId: req.user.userId,
            username: req.user.username,
            role: req.user.role,
        }).then((payment) => payment ? paymentPublicView(payment) : null);
    }

    @Patch(':id')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
    async updatePayment(
        @Param('id') id: string,
        @Body() body: UpdatePaymentDto,
        @Request() req: any,
    ) {
        const res = await this.paymentsService.updatePayment(id, body, {
            userId: req.user.userId,
            username: req.user.username,
            name: req.user.name,
            role: req.user.role,
        });
        this.paymentsGateway.emitPaymentsChanged({ type: 'PAYMENT_UPDATED', paymentId: id, targetUserId: res.createdById });
        return paymentPublicView(res);
    }
}
