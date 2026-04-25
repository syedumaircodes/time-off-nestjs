import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeaveBalance } from './entities/leave-balance.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { TimeOffService } from './time-off.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'database.sqlite',
      entities: [LeaveBalance, TimeOffRequest],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([LeaveBalance, TimeOffRequest]),
  ],
  controllers: [],
  providers: [TimeOffService],
})
export class AppModule {}
