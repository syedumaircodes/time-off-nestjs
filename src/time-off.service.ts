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
    @InjectRepository(SyncLog)
    private syncLogRepo: Repository<SyncLog>,
  ) {}

  /**
   * TRD 3.1 & 4.3: Concurrency Control via Manual Optimistic Locking
   */
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

    const maxRetries = 5;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        // 1. Fetch fresh balance
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
            balance = await this.balanceRepo.findOne({
              where: { employeeId, locationId },
            });
            if (!balance) throw e;
          }
        }

        // 2. Local Validation (Layer 1)
        const effectiveBalance = balance.availableDays - balance.reservedDays;
        if (effectiveBalance < days) {
          throw new BadRequestException('Insufficient balance');
        }

        // 3. ATOMIC UPDATE with Version Check
        // This ensures that if another request changed the version, affected will be 0
        const updateResult = await this.balanceRepo.update(
          { id: balance.id, version: balance.version },
          { reservedDays: balance.reservedDays + days },
        );

        if (updateResult.affected === 0) {
          throw new Error('VERSION_MISMATCH');
        }

        // 4. Create Request record
        const request = this.requestRepo.create({
          id: requestId,
          employeeId,
          locationId,
          daysRequested: days,
          status: RequestStatus.PENDING,
        });

        return await this.requestRepo.save(request);
      } catch (error) {
        if (
          error.message === 'VERSION_MISMATCH' ||
          error.code === 'SQLITE_CONSTRAINT'
        ) {
          attempt++;
          // Wait briefly to allow the other request to finish
          await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
          continue;
        }
        throw error; // Rethrow actual BadRequestExceptions (400)
      }
    }
    throw new ConflictException(
      'High contention on balance. Please try again.',
    );
  }

  /**
   * TRD 4.4: Approval with Defensive re-verification
   */
  async approveRequest(requestId: string) {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });

    // If syncBatch already failed it, this will throw 400, satisfying Test 7
    if (!request || request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        'Request is no longer pending or does not exist',
      );
    }

    const balance = await this.balanceRepo.findOne({
      where: { employeeId: request.employeeId, locationId: request.locationId },
    });
    if (!balance) throw new NotFoundException('Balance not found');

    try {
      const hcmRes = await axios.get(
        `${this.HCM_URL}/balances/${request.employeeId}/${request.locationId}`,
      );

      // LAYER 2 CHECK: Does the LIVE HCM balance cover THIS specific request?
      if (hcmRes.data.balance < request.daysRequested) {
        request.status = RequestStatus.FAILED;
        request.failureReason = 'HCM_BALANCE_INSUFFICIENT_AT_APPROVAL';
        balance.reservedDays -= request.daysRequested;
        await this.balanceRepo.save(balance);
        await this.requestRepo.save(request);
        // Throw 400 to satisfy the test requirement
        throw new BadRequestException(
          'Approval blocked: HCM balance insufficient',
        );
      }

      // LAYER 3: File to HCM
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
      if (error instanceof BadRequestException) throw error;

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

  /**
   * TRD 4.5 & 7.3: Selective Failure Logic
   */
  async syncBatchBalances(
    balances: { employeeId: string; locationId: string; balance: number }[],
  ) {
    for (const item of balances) {
      let local = await this.balanceRepo.findOne({
        where: { employeeId: item.employeeId, locationId: item.locationId },
      });

      if (!local) {
        local = await this.balanceRepo.save(
          this.balanceRepo.create({
            employeeId: item.employeeId,
            locationId: item.locationId,
            availableDays: item.balance,
            reservedDays: 0,
          }),
        );
      } else {
        local.availableDays = item.balance;
        await this.balanceRepo.save(local);
      }

      // TRD 4.5: Selective Fail. Check requests one-by-one.
      const pendings = await this.requestRepo.find({
        where: {
          employeeId: item.employeeId,
          locationId: item.locationId,
          status: RequestStatus.PENDING,
        },
        order: { createdAt: 'ASC' }, // Oldest requests get priority
      });

      let trackedAvailable = local.availableDays;
      for (const req of pendings) {
        if (req.daysRequested <= trackedAvailable) {
          // This request still fits in the new balance
          trackedAvailable -= req.daysRequested;
        } else {
          // This request breaches the new balance - FAIL IT
          req.status = RequestStatus.FAILED;
          req.failureReason = 'BALANCE_REDUCED_BY_HCM';
          local.reservedDays -= req.daysRequested;

          await this.requestRepo.save(req);
          await this.balanceRepo.save(local);
          // trackedAvailable doesn't change because this request is no longer reserved
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

  async manualSync(employeeId: string, locationId: string) {
    const res = await axios.get(
      `${this.HCM_URL}/balances/${employeeId}/${locationId}`,
    );
    let balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });
    if (!balance) balance = this.balanceRepo.create({ employeeId, locationId });
    balance.availableDays = res.data.balance;
    balance.lastSyncedAt = new Date();
    return await this.balanceRepo.save(balance);
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
}
