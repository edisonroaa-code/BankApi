import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/entities/user.entity';

@Controller('reports')
export class ReportsController {
    constructor(private reportsService: ReportsService) { }

    @Get('export')
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR)
    async exportReport(
        @Res() res: Response,
        @Query('format') format: 'xlsx' | 'pdf' = 'xlsx',
        @Query('month') month?: string,
        @Query('year') year?: string,
    ) {
        // Calculate date range from month/year or use current month
        const now = new Date();
        const targetMonth = month ? parseInt(month, 10) : now.getMonth();
        const targetYear = year ? parseInt(year, 10) : now.getFullYear();

        const startDate = new Date(targetYear, targetMonth, 1);
        const endDate = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);

        const filters = { startDate, endDate };
        const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
        const fileName = `Reporte_${monthNames[targetMonth]}_${targetYear}`;

        if (format === 'pdf') {
            const buffer = await this.reportsService.generatePdf(filters);
            res.set({
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${fileName}.pdf"`,
                'Content-Length': buffer.length,
            });
            res.send(buffer);
        } else {
            const buffer = await this.reportsService.generateExcel(filters);
            res.set({
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="${fileName}.xlsx"`,
                'Content-Length': buffer.length,
            });
            res.send(buffer);
        }
    }
}
