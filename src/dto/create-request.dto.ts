import { IsString, IsNumber, Min } from 'class-validator';

export class CreateRequestDto {
  @IsString()
  locationId: string;

  @IsNumber()
  @Min(0.5) // Allow half-days if needed, but at least 0.5
  days: number;
}
