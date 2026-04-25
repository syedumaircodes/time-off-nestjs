import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

@Entity()
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  syncType: string; // 'REALTIME' | 'BATCH'

  @Column({ nullable: true })
  employeeId: string;

  @Column()
  status: string; // 'SUCCESS' | 'FAILURE'

  @Column({ nullable: true })
  details: string;

  @CreateDateColumn()
  createdAt: Date;
}
