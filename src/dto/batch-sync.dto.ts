import { IsArray, IsString, IsNumber } from 'class-validator';

class BalanceItem {
  @IsString()
  employeeId: string;
  @IsString()
  locationId: string;
  @IsNumber()
  balance: number;
}

export class BatchSyncDto {
  @IsArray()
  balances: BalanceItem[];
}
