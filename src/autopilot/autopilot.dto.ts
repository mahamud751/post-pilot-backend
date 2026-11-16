import {ApiPropertyOptional} from '@nestjs/swagger';
import {AutopilotMode, GrowthGoal} from '@prisma/client';
import {Type} from 'class-transformer';
import {IsBoolean, IsEnum, IsInt, IsOptional, Max, Min} from 'class-validator';

export class UpdateAutopilotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({enum: AutopilotMode})
  @IsOptional()
  @IsEnum(AutopilotMode)
  mode?: AutopilotMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autopublishEnabled?: boolean;

  @ApiPropertyOptional({enum: GrowthGoal})
  @IsOptional()
  @IsEnum(GrowthGoal)
  goal?: GrowthGoal;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(14)
  postsPerWeek?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  dailyPostLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  analyzeEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  generateEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  optimizeSchedule?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  researchEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  creativesEnabled?: boolean;

  @ApiPropertyOptional({description: 'Run autopilot automatically on a fixed cadence.'})
  @IsOptional()
  @IsBoolean()
  scheduleEnabled?: boolean;

  @ApiPropertyOptional({description: 'Days between automatic runs.'})
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  runEveryDays?: number;
}
