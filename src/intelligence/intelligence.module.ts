import {Module} from '@nestjs/common';
import {ExperimentsService} from './experiments.service';
import {CreativeService} from './creative.service';
import {MemoryService} from './memory.service';
import {ResearchService} from './research.service';

@Module({
  providers: [MemoryService, ExperimentsService, ResearchService, CreativeService],
  exports: [MemoryService, ExperimentsService, ResearchService, CreativeService],
})
export class IntelligenceModule {}
