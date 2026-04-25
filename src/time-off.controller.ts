import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { TimeOffService } from './time-off.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { BatchSyncDto } from './dto/batch-sync.dto';

@Controller()
export class TimeOffController {
  constructor(private readonly timeOffService: TimeOffService) {}

  // 5.1 Employee Endpoints
  @Get('employees/:id/balances')
  getBalances(@Param('id') id: string) {
    return this.timeOffService.getEmployeeBalances(id);
  }

  @Post('employees/:id/requests')
  createRequest(@Param('id') id: string, @Body() dto: CreateRequestDto) {
    return this.timeOffService.submitRequest(id, dto.locationId, dto.days);
  }

  // 5.2 Manager Endpoints
  @Patch('requests/:id/approve')
  approve(@Param('id') id: string) {
    return this.timeOffService.approveRequest(id);
  }

  @Patch('requests/:id/reject')
  reject(@Param('id') id: string) {
    return this.timeOffService.rejectRequest(id);
  }

  // 5.3 Webhooks
  @Post('webhooks/hcm/balances')
  syncBatch(@Body() dto: BatchSyncDto) {
    // In a real app, you'd verify the HMAC signature here as per TRD 8.0
    return this.timeOffService.syncBatchBalances(dto.balances);
  }
  // Add this to the TimeOffController class
  @Get('employees/:id/requests')
  getRequests(@Param('id') id: string) {
    return this.timeOffService.getEmployeeRequests(id);
  }

  @Delete('employees/:id/requests/:requestId')
  async cancel(@Param('requestId') requestId: string) {
    return await this.timeOffService.cancelRequest(requestId);
  }

  @Post('sync/employees/:id/locations/:locationId')
  async triggerManualSync(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
  ) {
    return await this.timeOffService.manualSync(id, locationId);
  }
}
