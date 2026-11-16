import {Body, Controller, Headers, Post, UnauthorizedException} from '@nestjs/common';
import {ApiTags} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {IsNumber, IsOptional, IsString, MaxLength, Min} from 'class-validator';
import {ResearchService} from '../intelligence/research.service';

class ConversionDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsString()
  postId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @IsOptional()
  @IsString()
  occurredAt?: string;
}

/** Store webhook. Authenticated by the workspace conversion key, not a user session. */
@ApiTags('conversions')
@Controller('conversions')
export class ConversionsController {
  constructor(private readonly research: ResearchService) {}

  @Post()
  async create(@Headers('x-conversion-key') key: string | undefined, @Body() input: ConversionDto) {
    const workspaceId = await this.research.workspaceForConversionKey(key || '');
    if (!workspaceId) {
      throw new UnauthorizedException('A valid conversion key is required.');
    }
    return this.research.recordSale(workspaceId, input, 'webhook');
  }
}
