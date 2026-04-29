import {Body, Controller, Post, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {AiService} from './ai.service';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('caption-suggestions')
  captionSuggestions(@Body() body: {topic?: string; tone?: string}) {
    return this.aiService.captionSuggestions(body?.topic, body?.tone);
  }
}

