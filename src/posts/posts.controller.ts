import {Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {CurrentWorkspace} from '../common/decorators/current-workspace.decorator';
import {
  CONTENT_WRITERS,
  RequireRoles,
  WORKSPACE_HEADER,
  WorkspaceContext,
  WorkspaceGuard,
} from '../workspaces/workspace.guard';
import {
  ApproveDto,
  CreatePostDto,
  ListPostsQuery,
  RejectDto,
  RetryDto,
  ReviewDto,
  ScheduleDto,
  UpdatePostDto,
} from './dto/post.dto';
import {PostsService} from './posts.service';

const REVIEWERS = ['OWNER', 'ADMIN', 'APPROVER'] as const;
const PARTICIPANTS = ['OWNER', 'ADMIN', 'EDITOR', 'APPROVER'] as const;

@ApiTags('posts')
@ApiBearerAuth()
@ApiHeader({name: WORKSPACE_HEADER, required: false})
@UseGuards(JwtAuthGuard, WorkspaceGuard)
@Controller()
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get('posts')
  list(@CurrentWorkspace() ctx: WorkspaceContext, @Query() query: ListPostsQuery) {
    return this.postsService.list(ctx.id, query);
  }

  @Post('posts')
  @RequireRoles(...CONTENT_WRITERS)
  async create(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: CreatePostDto,
  ) {
    return {post: await this.postsService.create(ctx, userId, input)};
  }

  @Get('posts/:id')
  async get(@CurrentWorkspace() ctx: WorkspaceContext, @Param('id') id: string) {
    return {post: await this.postsService.get(ctx, id)};
  }

  @Patch('posts/:id')
  @RequireRoles(...CONTENT_WRITERS)
  async update(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: UpdatePostDto,
  ) {
    return {post: await this.postsService.update(ctx, userId, id, input)};
  }

  @Delete('posts/:id')
  @RequireRoles(...CONTENT_WRITERS)
  remove(@CurrentWorkspace() ctx: WorkspaceContext, @CurrentUserId() userId: string, @Param('id') id: string) {
    return this.postsService.remove(ctx, userId, id);
  }

  @Post('posts/:id/submit')
  @RequireRoles(...CONTENT_WRITERS)
  async submit(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: ReviewDto,
  ) {
    return {post: await this.postsService.submit(ctx, userId, id, input.comment)};
  }

  @Post('posts/:id/approve')
  @RequireRoles(...REVIEWERS)
  async approve(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: ApproveDto,
  ) {
    return {post: await this.postsService.approve(ctx, userId, id, input)};
  }

  @Post('posts/:id/reject')
  @RequireRoles(...REVIEWERS)
  async reject(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: RejectDto,
  ) {
    return {post: await this.postsService.reject(ctx, userId, id, input.comment)};
  }

  @Post('posts/:id/comments')
  @RequireRoles(...PARTICIPANTS)
  async comment(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: RejectDto,
  ) {
    return {post: await this.postsService.comment(ctx, userId, id, input.comment)};
  }

  @Post('posts/:id/schedule')
  @RequireRoles(...PARTICIPANTS)
  async schedule(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: ScheduleDto,
  ) {
    return {post: await this.postsService.schedule(ctx, userId, id, input)};
  }

  @Post('posts/:id/cancel')
  @RequireRoles(...PARTICIPANTS)
  async cancel(@CurrentWorkspace() ctx: WorkspaceContext, @CurrentUserId() userId: string, @Param('id') id: string) {
    return {post: await this.postsService.cancelPost(ctx, userId, id)};
  }

  @Post('post-targets/:id/schedule')
  @RequireRoles(...PARTICIPANTS)
  async scheduleTarget(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: ScheduleDto,
  ) {
    return {post: await this.postsService.scheduleTarget(ctx, userId, id, input)};
  }

  @Post('post-targets/:id/cancel')
  @RequireRoles(...PARTICIPANTS)
  async cancelTarget(@CurrentWorkspace() ctx: WorkspaceContext, @CurrentUserId() userId: string, @Param('id') id: string) {
    return {post: await this.postsService.cancelTarget(ctx, userId, id)};
  }

  @Post('post-targets/:id/retry')
  @RequireRoles(...PARTICIPANTS)
  async retry(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: RetryDto,
  ) {
    return {post: await this.postsService.retryTarget(ctx, userId, id, input.confirmNotPublished)};
  }

  @Get('post-targets/:id/attempts')
  attempts(@CurrentWorkspace() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.postsService.attempts(ctx, id);
  }

  @Get('calendar')
  calendar(@CurrentWorkspace() ctx: WorkspaceContext, @Query('from') from: string, @Query('to') to: string) {
    return this.postsService.calendar(ctx, from, to);
  }
}
