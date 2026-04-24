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
  availableDays: number; // Current balance from HCM

  @Column({ type: 'float', default: 0 })
  reservedDays: number; // Logic: Held for PENDING requests

  @Column({ type: 'datetime', nullable: true })
  lastSyncedAt: Date;

  @VersionColumn() // This enables the automatic optimistic locking
  version: number;
}
