import { BadGatewayException, Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, Query, Request, ServiceUnavailableException } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { BankFeedService, BankFeedUnavailableError } from './bank-feed.service';
import { Actor, BankTransfersService } from './bank-transfers.service';
import {
  ClaimBankTransferDto,
  BankPrintPreviewDto,
  BankPrintConfirmationDto,
  ClaimIdDto,
  ReviewClaimDto,
  ListBankTransfersQueryDto,
  ListBankTransfersPageQueryDto,
  MatchesQueryDto,
  MyClaimsQueryDto,
  ReasonDto,
  ReviewQueueQueryDto,
  ReconcileBankTransferDto,
  VoidBankTransferClaimDto,
} from './dto/bank-transfer.dto';

const actorOf = (req: any): Actor => ({
  userId: req.user.userId,
  username: req.user.username,
  name: req.user.name,
  role: req.user.role,
});

/**
 * Transferencias entrantes vistas por la API del banco.
 * - CAJERO: ve el panel y toma contra un ticket o un cliente.
 * - COBRADOR: ve el panel y concilia unicamente sus propias consultas (lo valida el servicio).
 * - ADMIN: ve todo, toma directamente, concilia cualquier consulta, anula y libera.
 * - SUPERVISOR: solo mira (decision del 2026-10-07): panel y candidatas, con datos enmascarados;
 *   no toma, no concilia, no anula.
 */
@Controller('bank-transfers')
export class BankTransfersController {
  constructor(private readonly transfers: BankTransfersService) {}

  @Get()
  @Roles(UserRole.CAJERO, UserRole.COBRADOR, UserRole.SUPERVISOR, UserRole.ADMIN)
  list(@Query() query: ListBankTransfersQueryDto, @Request() req: any) {
    return this.transfers.list(query, actorOf(req));
  }

  /** Panel por mes, paginado, con lo pendiente de otros meses (antes de ':id' para no confundirse). */
  @Get('page')
  @Roles(UserRole.CAJERO, UserRole.COBRADOR, UserRole.SUPERVISOR, UserRole.ADMIN)
  listPage(@Query() query: ListBankTransfersPageQueryDto, @Request() req: any) {
    return this.transfers.listPage(query, actorOf(req));
  }

  @Get('claims/mine')
  @Roles(UserRole.CAJERO, UserRole.COBRADOR, UserRole.ADMIN)
  myClaims(@Query() query: MyClaimsQueryDto, @Request() req: any) {
    return this.transfers.myClaims(actorOf(req), query.date, query.month);
  }

  // Cola de revision del admin: lo que cerraron los cobradores y lo que se cerro sin evidencia.
  @Get('claims/review')
  @Roles(UserRole.ADMIN)
  claimsToReview(@Query() query: ReviewQueueQueryDto) {
    return this.transfers.claimsToReview(query);
  }

  // Coincidencias para una consulta: para conciliar y como alerta de doble uso al aprobar a mano.
  @Get('matches')
  @Roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR)
  matches(@Query() query: MatchesQueryDto, @Request() req: any) {
    return this.transfers.matchesForPayment(query.paymentId, actorOf(req));
  }

  @Get(':id')
  @Roles(UserRole.CAJERO, UserRole.COBRADOR, UserRole.SUPERVISOR, UserRole.ADMIN)
  getOne(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.transfers.getOne(id, actorOf(req));
  }

  @Get(':id/history')
  @Roles(UserRole.ADMIN)
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.history(id);
  }

  @Get(':id/candidate-payments')
  @Roles(UserRole.ADMIN, UserRole.COBRADOR, UserRole.SUPERVISOR)
  candidatePayments(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.transfers.candidatePayments(id, actorOf(req));
  }

  @Post(':id/claim')
  @Roles(UserRole.CAJERO, UserRole.ADMIN)
  claim(@Param('id', ParseUUIDPipe) id: string, @Body() body: ClaimBankTransferDto, @Request() req: any) {
    return this.transfers.claim(id, body, actorOf(req));
  }

  @Post(':id/void')
  @Roles(UserRole.ADMIN)
  void(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoidBankTransferClaimDto, @Request() req: any) {
    return this.transfers.void(id, body.reason, actorOf(req), body.claimId);
  }

  @Post(':id/release')
  @Roles(UserRole.ADMIN)
  release(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto, @Request() req: any) {
    return this.transfers.release(id, body.reason, actorOf(req));
  }

  /** Datos del comprobante para el dialogo de impresion; no lo cuenta como impreso. */
  @Post(':id/print-preview')
  @Roles(UserRole.CAJERO, UserRole.COBRADOR, UserRole.ADMIN)
  printPreview(@Param('id', ParseUUIDPipe) id: string, @Body() body: BankPrintPreviewDto, @Request() req: any) {
    return this.transfers.printPreview(id, actorOf(req), body?.claimId, body?.reason);
  }

  /** La persona confirmo que el comprobante salio impreso. */
  @Post(':id/print')
  @Roles(UserRole.CAJERO, UserRole.COBRADOR, UserRole.ADMIN)
  print(@Param('id', ParseUUIDPipe) id: string, @Body() body: BankPrintConfirmationDto, @Request() req: any) {
    return this.transfers.print(id, actorOf(req), body?.claimId, body?.authorizationId);
  }

  /** El admin reviso una conciliacion de la cola y esta bien: sale de la cola sin anular nada. */
  @Post(':id/review')
  @Roles(UserRole.ADMIN)
  review(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewClaimDto, @Request() req: any) {
    return this.transfers.markReviewed(id, body.claimId, actorOf(req));
  }

  @Post(':id/reconcile')
  @Roles(UserRole.ADMIN, UserRole.COBRADOR)
  reconcile(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReconcileBankTransferDto, @Request() req: any) {
    return this.transfers.reconcile(id, body.paymentId, body.idempotencyKey, actorOf(req), { amount: body.amount });
  }
}

@Controller('bank-feed')
export class BankFeedController {
  constructor(private readonly feed: BankFeedService) {}

  @Get('status')
  @Roles(UserRole.CAJERO, UserRole.COBRADOR, UserRole.SUPERVISOR, UserRole.ADMIN)
  status() {
    return this.feed.getStatus();
  }

  /** Saldo de la cuenta Atlas: solo el admin y a pedido (decision del 2026-10-07). */
  @Get('balance')
  @Roles(UserRole.ADMIN)
  async balance() {
    try {
      return await this.feed.getBalance();
    } catch (error: any) {
      if (error instanceof BankFeedUnavailableError) throw new ServiceUnavailableException(error.message);
      // Sin detalles tecnicos ni texto del banco no autenticado: eso queda en el log del backend.
      new Logger('BankFeedController').warn(`Consulta de saldo fallida: ${String(error?.message || error).slice(0, 200)}`);
      throw new BadGatewayException('No se pudo consultar el saldo en el banco. Reintentá en unos segundos.');
    }
  }

  /**
   * "Actualizar" desde cualquier pantalla del banco: una consulta compartida, con espera de 5 s
   * impuesta aca. Responde cuando el banco contesto, para que la pantalla relea la lista; a las
   * demas les llega por el tiempo real.
   */
  @Post('refresh')
  @Roles(UserRole.CAJERO, UserRole.COBRADOR, UserRole.SUPERVISOR, UserRole.ADMIN)
  async refresh(@Request() req: any) {
    try {
      return await this.feed.requestRefresh(String(req.user.name || req.user.username || 'usuario'));
    } catch (error) {
      if (error instanceof BankFeedUnavailableError) throw new ServiceUnavailableException(error.message);
      throw error;
    }
  }

  @Post('resume')
  @Roles(UserRole.ADMIN)
  resume() {
    return this.feed.resume();
  }
}
