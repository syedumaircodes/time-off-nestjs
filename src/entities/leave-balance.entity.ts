import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  VersionColumn,
  Unique,
} from 'typeorm';

@Entity()
@Unique(['employeeId', 'locationId'])
export class LeaveBalance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column({ type: 'float', default: 0 })
  availableDays: number;

  @Column({ type: 'float', default: 0 })
  reservedDays: number;

  @Column({ type: 'datetime', nullable: true })
  lastSyncedAt: Date;

  @VersionColumn() // This is critical for the Concurrency test
  version: number;
}
