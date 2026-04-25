import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
import { LeaveBalance } from './entities/leave-balance.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { SyncLog } from './entities/sync-log.entity';

// Service & Controller
import { TimeOffService } from './time-off.service';
import { TimeOffController } from './time-off.controller';

@Module({
  imports: [
    // 1. Database Connection Configuration
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'database.sqlite',
      entities: [LeaveBalance, TimeOffRequest, SyncLog],
      synchronize: true, // Auto-creates tables based on entities
    }),

    // 2. Register Repositories for Injection in TimeOffService
    TypeOrmModule.forFeature([LeaveBalance, TimeOffRequest, SyncLog]),

    // 3. Enable Task Scheduling (for the retry Cron job)
    ScheduleModule.forRoot(),
  ],
  controllers: [TimeOffController],
  providers: [TimeOffService],
})
export class AppModule {}
