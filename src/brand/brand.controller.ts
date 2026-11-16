import {Body, Controller, Get, Patch, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {CurrentWorkspace} from '../common/decorators/current-workspace.decorator';
import {
  RequireRoles,
  WORKSPACE_HEADER,
  WORKSPACE_MANAGERS,
  WorkspaceContext,
  WorkspaceGuard,
} from '../workspaces/workspace.guard';
import {UpdateBrandDto} from './brand.dto';
import {BrandService} from './brand.service';

@ApiTags('brand')
@ApiBearerAuth()
@ApiHeader({name: WORKSPACE_HEADER, required: false})
@UseGuards(JwtAuthGuard, WorkspaceGuard)
@Controller('brand')
export class BrandController {
  constructor(private readonly brandService: BrandService) {}

  @Get()
  async get(@CurrentWorkspace() ctx: WorkspaceContext) {
    return {brand: await this.brandService.get(ctx.id)};
  }

  @Patch()
  @RequireRoles(...WORKSPACE_MANAGERS)
  async update(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: UpdateBrandDto,
  ) {
    return {brand: await this.brandService.update(ctx.id, userId, input)};
  }
}
