import {
  Injectable,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeaveBalance } from './entities/leave-balance.entity';
import {
  TimeOffRequest,
  RequestStatus,
} from './entities/time-off-request.entity';
import axios from 'axios';

@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);
  private readonly HCM_URL = 'http://localhost:3001';

  constructor(
    @InjectRepository(LeaveBalance)
    private balanceRepo: Repository<LeaveBalance>,
    @InjectRepository(TimeOffRequest)
    private requestRepo: Repository<TimeOffRequest>,
  ) {}

  async submitRequest(employeeId: string, locationId: string, days: number) {
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        let balance = await this.balanceRepo.findOne({
          where: { employeeId, locationId },
        });

        // Logic: Create balance if missing locally
        if (!balance) {
          const newBalance = this.balanceRepo.create({
            employeeId,
            locationId,
            availableDays: 0,
            reservedDays: 0,
          });
          balance = await this.balanceRepo.save(newBalance);
        }

        const effectiveBalance = balance.availableDays - balance.reservedDays;

        if (effectiveBalance < days) {
          throw new BadRequestException(
            `Insufficient balance. Effective: ${effectiveBalance}`,
          );
        }

        balance.reservedDays += days;
        await this.balanceRepo.save(balance);

        const request = this.requestRepo.create({
          employeeId,
          locationId,
          daysRequested: days,
          status: RequestStatus.PENDING,
        });

        return await this.requestRepo.save(request);
      } catch (error) {
        // Fix for TypeORM specific error check
        if (error.name === 'OptimisticLockVersionMismatchError') {
          attempt++;
          this.logger.warn(
            `Concurrency detected. Retry ${attempt}/${maxRetries}`,
          );
          continue;
        }
        throw error;
      }
    }
    throw new ConflictException(
      'Could not process request due to high contention.',
    );
  }

  async approveRequest(requestId: string) {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request || request.status !== RequestStatus.PENDING) {
      throw new BadRequestException('Invalid request status');
    }

    const balance = await this.balanceRepo.findOne({
      where: { employeeId: request.employeeId, locationId: request.locationId },
    });

    // Guard against null balance
    if (!balance) {
      throw new NotFoundException('Local balance record not found');
    }

    try {
      // Layer 2: Re-verify with HCM
      const hcmRes = await axios.get(
        `${this.HCM_URL}/balances/${request.employeeId}/${request.locationId}`,
      );
      const actualHcmBalance = hcmRes.data.balance;

      if (actualHcmBalance < request.daysRequested) {
        request.status = RequestStatus.FAILED;
        request.failureReason = 'HCM balance insufficient at approval';
        balance.reservedDays -= request.daysRequested;

        await this.balanceRepo.save(balance);
        await this.requestRepo.save(request);
        throw new BadRequestException('HCM balance changed independently');
      }

      // Layer 3: File to HCM
      await axios.post(`${this.HCM_URL}/time-off`, {
        employeeId: request.employeeId,
        locationId: request.locationId,
        days: request.daysRequested,
      });

      // Update state
      balance.availableDays -= request.daysRequested;
      balance.reservedDays -= request.daysRequested;
      balance.lastSyncedAt = new Date();
      await this.balanceRepo.save(balance);

      request.status = RequestStatus.APPROVED;
      request.hcmFiled = true;
      return await this.requestRepo.save(request);
    } catch (error) {
      this.logger.error(`Approval error: ${error.message}`);

      request.status = RequestStatus.FAILED;
      request.failureReason = error.response?.data?.error || 'HCM Sync Error';

      // Safety restore
      balance.reservedDays -= request.daysRequested;
      await this.balanceRepo.save(balance);
      await this.requestRepo.save(request);

      throw new InternalServerErrorException('Sync failed');
    }
  }

  async rejectRequest(requestId: string) {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request || request.status !== RequestStatus.PENDING) {
      throw new BadRequestException('Request not found');
    }

    const balance = await this.balanceRepo.findOne({
      where: { employeeId: request.employeeId, locationId: request.locationId },
    });

    if (balance) {
      balance.reservedDays -= request.daysRequested;
      await this.balanceRepo.save(balance);
    }

    request.status = RequestStatus.REJECTED;
    return await this.requestRepo.save(request);
  }

  async getEmployeeBalances(employeeId: string) {
    return this.balanceRepo.find({ where: { employeeId } });
  }
}
