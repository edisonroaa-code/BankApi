import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Payment, PaymentState } from './entities/payment.entity';
import * as ExcelJS from 'exceljs';
import * as PDFDocument from 'pdfkit';
import { Readable } from 'stream';

export interface ReportFilters {
    startDate?: Date;
    endDate?: Date;
}

@Injectable()
export class ReportsService {
    constructor(
        @InjectRepository(Payment)
        private paymentsRepo: Repository<Payment>,
    ) { }

    private async getPaymentsForReport(filters: ReportFilters): Promise<Payment[]> {
        const where: any = {};
        if (filters.startDate && filters.endDate) {
            where.createdAt = Between(filters.startDate, filters.endDate);
        }
        return this.paymentsRepo.find({
            where,
            order: { createdAt: 'DESC' },
            relations: ['createdBy', 'verifiedBy'],
        });
    }

    async generateExcel(filters: ReportFilters): Promise<Buffer> {
        const companyName = (process.env.COMPANY_NAME || 'BankApi').trim() || 'BankApi';
        const payments = await this.getPaymentsForReport(filters);
        const workbook = new ExcelJS.Workbook();
        workbook.creator = companyName;
        workbook.created = new Date();

        // --- RESUMEN Sheet ---
        const summarySheet = workbook.addWorksheet('Resumen');
        summarySheet.columns = [
            { header: 'Estado', key: 'status', width: 25 },
            { header: 'Cantidad', key: 'count', width: 15 },
            { header: 'Total (Gs)', key: 'total', width: 20 },
        ];

        const statusGroups: Record<string, { count: number; total: number }> = {};
        const statusLabels: Record<string, string> = {
            [PaymentState.PENDIENTE_VERIFICACION]: 'Pendiente',
            [PaymentState.EN_REVISION]: 'En Revisión',
            [PaymentState.CONFIRMADO]: 'Confirmado (Auto)',
            [PaymentState.CONFIRMADO_MANUAL]: 'Confirmado (Manual)',
            [PaymentState.RECHAZADO]: 'Rechazado',
        };

        for (const p of payments) {
            if (!statusGroups[p.status]) {
                statusGroups[p.status] = { count: 0, total: 0 };
            }
            statusGroups[p.status].count++;
            statusGroups[p.status].total += Number(p.amount) || 0;
        }

        for (const [status, data] of Object.entries(statusGroups)) {
            summarySheet.addRow({
                status: statusLabels[status] || status,
                count: data.count,
                total: data.total,
            });
        }

        // Add total row
        summarySheet.addRow({
            status: 'TOTAL',
            count: payments.length,
            total: payments.reduce((acc, p) => acc + (Number(p.amount) || 0), 0),
        });

        // Style header row
        summarySheet.getRow(1).font = { bold: true };
        summarySheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF1E293B' },
        };
        summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        // --- DETALLE Sheet ---
        const detailSheet = workbook.addWorksheet('Detalle');
        detailSheet.columns = [
            { header: 'Fecha', key: 'date', width: 18 },
            { header: 'Cliente', key: 'client', width: 25 },
            { header: 'Código', key: 'code', width: 15 },
            { header: 'Monto (Gs)', key: 'amount', width: 18 },
            { header: 'Estado', key: 'status', width: 20 },
            { header: 'Cobrador', key: 'collector', width: 20 },
            { header: 'Revisor', key: 'reviewer', width: 20 },
            { header: 'Referencia', key: 'ref', width: 15 },
        ];

        for (const p of payments) {
            const createdBy = typeof p.createdBy === 'object' ? p.createdBy : null;

            detailSheet.addRow({
                date: new Date(p.createdAt).toLocaleString('es-PY', { timeZone: 'America/Asuncion' }),
                client: p.clientName || '-',
                code: p.clientCode || '-',
                amount: Number(p.amount) || 0,
                status: statusLabels[p.status] || p.status,
                collector: createdBy?.name || createdBy?.username || '-',
                reviewer: p.verifiedByName || p.verifiedByUsername || '-',
                ref: p.paymentRef || '-',
            });
        }

        detailSheet.getRow(1).font = { bold: true };
        detailSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF1E293B' },
        };
        detailSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        // --- POR COBRADOR Sheet ---
        const byCollectorSheet = workbook.addWorksheet('Por Cobrador');
        byCollectorSheet.columns = [
            { header: 'Cobrador', key: 'collector', width: 25 },
            { header: 'Consultas', key: 'count', width: 15 },
            { header: 'Confirmados', key: 'confirmed', width: 15 },
            { header: 'Rechazados', key: 'rejected', width: 15 },
            { header: 'Total Confirmado (Gs)', key: 'total', width: 22 },
        ];

        const collectorStats: Record<string, { count: number; confirmed: number; rejected: number; total: number }> = {};
        for (const p of payments) {
            const createdBy = typeof p.createdBy === 'object' ? p.createdBy : null;
            const collectorName = createdBy?.name || createdBy?.username || 'Desconocido';
            if (!collectorStats[collectorName]) {
                collectorStats[collectorName] = { count: 0, confirmed: 0, rejected: 0, total: 0 };
            }
            collectorStats[collectorName].count++;
            if (p.status === PaymentState.CONFIRMADO || p.status === PaymentState.CONFIRMADO_MANUAL) {
                collectorStats[collectorName].confirmed++;
                collectorStats[collectorName].total += Number(p.amount) || 0;
            }
            if (p.status === PaymentState.RECHAZADO) {
                collectorStats[collectorName].rejected++;
            }
        }

        for (const [collector, stats] of Object.entries(collectorStats)) {
            byCollectorSheet.addRow({
                collector,
                count: stats.count,
                confirmed: stats.confirmed,
                rejected: stats.rejected,
                total: stats.total,
            });
        }

        byCollectorSheet.getRow(1).font = { bold: true };
        byCollectorSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF1E293B' },
        };
        byCollectorSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        const buffer = await workbook.xlsx.writeBuffer();
        return Buffer.from(buffer);
    }

    async generatePdf(filters: ReportFilters): Promise<Buffer> {
        const companyName = (process.env.COMPANY_NAME || 'BankApi').trim() || 'BankApi';
        const payments = await this.getPaymentsForReport(filters);

        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const chunks: Buffer[] = [];

            doc.on('data', (chunk) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Header
            doc.fontSize(20).font('Helvetica-Bold').text(companyName.toUpperCase(), { align: 'center' });
            doc.fontSize(12).font('Helvetica').text('Reporte de Verificación de Cobranzas y Transferencias', { align: 'center' });
            doc.moveDown();

            const dateRange = filters.startDate && filters.endDate
                ? `${filters.startDate.toLocaleDateString('es-PY')} - ${filters.endDate.toLocaleDateString('es-PY')}`
                : 'Todos los registros';
            doc.fontSize(10).text(`Período: ${dateRange}`, { align: 'center' });
            doc.text(`Generado: ${new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion' })}`, { align: 'center' });
            doc.moveDown(2);

            // Summary
            const statusLabels: Record<string, string> = {
                [PaymentState.PENDIENTE_VERIFICACION]: 'Pendiente',
                [PaymentState.EN_REVISION]: 'En Revisión',
                [PaymentState.CONFIRMADO]: 'Confirmado (Auto)',
                [PaymentState.CONFIRMADO_MANUAL]: 'Confirmado (Manual)',
                [PaymentState.RECHAZADO]: 'Rechazado',
            };

            const statusGroups: Record<string, { count: number; total: number }> = {};
            for (const p of payments) {
                if (!statusGroups[p.status]) {
                    statusGroups[p.status] = { count: 0, total: 0 };
                }
                statusGroups[p.status].count++;
                statusGroups[p.status].total += Number(p.amount) || 0;
            }

            doc.fontSize(14).font('Helvetica-Bold').text('Resumen por Estado');
            doc.moveDown(0.5);

            const formatCurrency = (val: number) =>
                new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(val);

            for (const [status, data] of Object.entries(statusGroups)) {
                doc.fontSize(10).font('Helvetica')
                    .text(`${statusLabels[status] || status}: ${data.count} operaciones - ${formatCurrency(data.total)}`);
            }

            doc.moveDown();
            const totalAmount = payments.reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
            const confirmedAmount = payments
                .filter((p) => p.status === PaymentState.CONFIRMADO || p.status === PaymentState.CONFIRMADO_MANUAL)
                .reduce((acc, p) => acc + (Number(p.amount) || 0), 0);

            doc.font('Helvetica-Bold').text(`Total Operaciones: ${payments.length}`);
            doc.text(`Total Declarado: ${formatCurrency(totalAmount)}`);
            doc.text(`Total Confirmado: ${formatCurrency(confirmedAmount)}`);

            doc.moveDown(2);

            // Footer
            doc.fontSize(8).font('Helvetica').fillColor('#666666')
                .text(`Documento generado automáticamente - ${companyName} · BankApi`, 50, doc.page.height - 50, { align: 'center' });

            doc.end();
        });
    }
}
