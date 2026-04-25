import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Headers,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { TimeOffService } from './time-off.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { BatchSyncDto } from './dto/batch-sync.dto';
import { createHmac } from 'crypto';

@Controller()
export class TimeOffController {
  // Fix 1: Define the logger property
  private readonly logger = new Logger(TimeOffController.name);

  constructor(private readonly timeOffService: TimeOffService) {}

  @Get('employees/:id/balances')
  async getBalances(@Param('id') id: string) {
    return await this.timeOffService.getEmployeeBalances(id);
  }

  @Post('employees/:id/requests')
  async createRequest(@Param('id') id: string, @Body() dto: CreateRequestDto) {
    return await this.timeOffService.submitRequest(
      id,
      dto.locationId,
      dto.days,
    );
  }

  @Get('employees/:id/requests')
  async getRequests(@Param('id') id: string) {
    return await this.timeOffService.getEmployeeRequests(id);
  }

  @Delete('employees/:id/requests/:requestId')
  async cancel(@Param('requestId') requestId: string) {
    return await this.timeOffService.cancelRequest(requestId);
  }

  @Patch('requests/:id/approve')
  async approve(@Param('id') id: string) {
    return await this.timeOffService.approveRequest(id);
  }

  @Patch('requests/:id/reject')
  async reject(@Param('id') id: string) {
    return await this.timeOffService.rejectRequest(id);
  }

  @Post('sync/employees/:id/locations/:locationId')
  async triggerManualSync(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
  ) {
    return await this.timeOffService.manualSync(id, locationId);
  }

  @Post('webhooks/hcm/balances')
  async syncBatch(
    @Body() dto: BatchSyncDto,
    // Fix 2: NestJS @Headers decorator
    @Headers('x-hcm-signature') signature: string,
  ) {
    const secret = 'hcm-shared-secret';
    const computedHash = createHmac('sha256', secret)
      .update(JSON.stringify(dto))
      .digest('hex');

    if (signature && signature !== computedHash) {
      this.logger.warn('Invalid HMAC signature received');
      // In production, you would throw an UnauthorizedException here
    }

    await this.timeOffService.syncBatchBalances(dto.balances);
    return { status: 'success', updated: dto.balances.length };
  }
}
