import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  BadGatewayException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeaveBalance } from './entities/leave-balance.entity';
import {
  TimeOffRequest,
  RequestStatus,
} from './entities/time-off-request.entity';
import { SyncLog } from './entities/sync-log.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
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
    @InjectRepository(SyncLog) private syncLogRepo: Repository<SyncLog>,
  ) {}

  async submitRequest(
    employeeId: string,
    locationId: string,
    days: number,
    requestId?: string,
  ) {
    if (requestId) {
      const existing = await this.requestRepo.findOne({
        where: { id: requestId },
      });
      if (existing) return existing;
    }

    const maxRetries = 5; // Increased retries for high contention
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        // Always fetch a FRESH copy from the DB at the start of the loop
        let balance = await this.balanceRepo.findOne({
          where: { employeeId, locationId },
        });

        if (!balance) {
          try {
            balance = await this.balanceRepo.save(
              this.balanceRepo.create({
                employeeId,
                locationId,
                availableDays: 0,
                reservedDays: 0,
              }),
            );
          } catch (e) {
            // If another request created it while we were trying, fetch that one
            balance = await this.balanceRepo.findOne({
              where: { employeeId, locationId },
            });
            if (!balance) throw e;
          }
        }

        const effectiveBalance = balance.availableDays - balance.reservedDays;
        if (effectiveBalance < days) {
          throw new BadRequestException('Insufficient balance');
        }

        // Increment locally
        balance.reservedDays += days;

        // Save using TypeORM's built-in Optimistic Locking (@Version column)
        await this.balanceRepo.save(balance);

        const request = this.requestRepo.create({
          id: requestId,
          employeeId,
          locationId,
          daysRequested: days,
          status: RequestStatus.PENDING,
        });

        return await this.requestRepo.save(request);
      } catch (error) {
        // If the version changed between our Read and our Write, retry the logic
        if (
          error.name === 'OptimisticLockVersionMismatchError' ||
          error.code === 'SQLITE_CONSTRAINT'
        ) {
          attempt++;
          // Small delay to let the other request finish
          await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
          continue;
        }
        throw error;
      }
    }
    throw new ConflictException(
      'High contention on balance update. Please try again.',
    );
  }

  async approveRequest(requestId: string) {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request || request.status !== RequestStatus.PENDING)
      throw new BadRequestException('Invalid request');

    // Fetch fresh balance
    const balance = await this.balanceRepo.findOne({
      where: { employeeId: request.employeeId, locationId: request.locationId },
    });
    if (!balance) throw new NotFoundException('Balance not found');

    try {
      // Layer 2: Re-verify
      const hcmRes = await axios.get(
        `${this.HCM_URL}/balances/${request.employeeId}/${request.locationId}`,
      );
      if (hcmRes.data.balance < request.daysRequested) {
        request.status = RequestStatus.FAILED;
        balance.reservedDays -= request.daysRequested;
        await this.balanceRepo.save(balance);
        return await this.requestRepo.save(request);
      }

      // Layer 3: Deduct
      await axios.post(`${this.HCM_URL}/time-off`, {
        employeeId: request.employeeId,
        locationId: request.locationId,
        days: request.daysRequested,
      });

      request.hcmFiled = true;
      request.status = RequestStatus.APPROVED;
      balance.availableDays -= request.daysRequested;
      balance.reservedDays -= request.daysRequested;
    } catch (error) {
      if (error.response?.status === 400) {
        throw new BadGatewayException('HCM rejected request (400)');
      }
      // TRD 4.6 Resilience
      this.logger.warn(`HCM Down. Optimistic Approval for ${requestId}`);
      request.status = RequestStatus.APPROVED;
      request.hcmFiled = false;
      balance.availableDays -= request.daysRequested;
      balance.reservedDays -= request.daysRequested;
    }

    await this.balanceRepo.save(balance);
    return await this.requestRepo.save(request);
  }

  async syncBatchBalances(
    balances: { employeeId: string; locationId: string; balance: number }[],
  ) {
    for (const item of balances) {
      let local = await this.balanceRepo.findOne({
        where: { employeeId: item.employeeId, locationId: item.locationId },
      });

      if (!local) {
        local = this.balanceRepo.create({
          employeeId: item.employeeId,
          locationId: item.locationId,
          availableDays: item.balance,
          reservedDays: 0,
        });
        await this.balanceRepo.save(local);
      } else {
        local.availableDays = item.balance;
        await this.balanceRepo.save(local);
      }

      // TRD 4.5 Auto-fail invalid pending requests
      const pendings = await this.requestRepo.find({
        where: {
          employeeId: item.employeeId,
          locationId: item.locationId,
          status: RequestStatus.PENDING,
        },
      });
      for (const req of pendings) {
        if (local.availableDays < local.reservedDays) {
          req.status = RequestStatus.FAILED;
          req.failureReason = 'BALANCE_REDUCED_BY_HCM';
          local.reservedDays -= req.daysRequested;
          await this.requestRepo.save(req);
          await this.balanceRepo.save(local);
        }
      }
    }
    await this.syncLogRepo.save(
      this.syncLogRepo.create({ syncType: 'BATCH', status: 'SUCCESS' }),
    );
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async retryUnfiledDeductions() {
    const unfiled = await this.requestRepo.find({
      where: { status: RequestStatus.APPROVED, hcmFiled: false },
    });
    for (const req of unfiled) {
      try {
        await axios.post(`${this.HCM_URL}/time-off`, {
          employeeId: req.employeeId,
          locationId: req.locationId,
          days: req.daysRequested,
        });
        req.hcmFiled = true;
        await this.requestRepo.save(req);
      } catch (e) {}
    }
  }

  async getEmployeeBalances(employeeId: string) {
    return this.balanceRepo.find({ where: { employeeId } });
  }
  async getEmployeeRequests(employeeId: string) {
    return this.requestRepo.find({
      where: { employeeId },
      order: { createdAt: 'DESC' },
    });
  }
  async rejectRequest(requestId: string) {
    const req = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!req || req.status !== RequestStatus.PENDING) return;
    const balance = await this.balanceRepo.findOne({
      where: { employeeId: req.employeeId, locationId: req.locationId },
    });
    if (balance) {
      balance.reservedDays -= req.daysRequested;
      await this.balanceRepo.save(balance);
    }
    req.status = RequestStatus.REJECTED;
    return await this.requestRepo.save(req);
  }
  async cancelRequest(requestId: string) {
    return this.rejectRequest(requestId);
  }
  /**
   * TRD 5.3: Manual real-time sync (Admin/System use)
   * Fetches balance directly from HCM and updates the local cache.
   */
  async manualSync(employeeId: string, locationId: string) {
    try {
      const res = await axios.get(
        `${this.HCM_URL}/balances/${employeeId}/${locationId}`,
      );
      const hcmBalance = res.data.balance;

      let localBalance = await this.balanceRepo.findOne({
        where: { employeeId, locationId },
      });

      if (!localBalance) {
        localBalance = this.balanceRepo.create({
          employeeId,
          locationId,
          availableDays: hcmBalance,
          reservedDays: 0,
        });
      } else {
        localBalance.availableDays = hcmBalance;
      }

      localBalance.lastSyncedAt = new Date();
      return await this.balanceRepo.save(localBalance);
    } catch (error) {
      this.logger.error(
        `Manual sync failed for ${employeeId}: ${error.message}`,
      );
      throw new BadGatewayException('Could not synchronize with HCM system');
    }
  }
}
