import {Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiTags} from '@nestjs/swagger';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CreatePostDto} from './dto/create-post.dto';
import {UpdatePostDto} from './dto/update-post.dto';
import {PostsService} from './posts.service';

@ApiTags('posts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post()
  async create(@CurrentUserId() userId: string, @Body() input: CreatePostDto) {
    const post = await this.postsService.create(userId, input);
    return {post};
  }

  @Get()
  async findAll(@CurrentUserId() userId: string, @Query('status') status?: string) {
    const posts = await this.postsService.findAll(userId, status);
    return {posts};
  }

  @Patch(':id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: UpdatePostDto,
  ) {
    const post = await this.postsService.update(userId, id, input);
    return {post};
  }

  @Delete(':id')
  remove(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.postsService.remove(userId, id);
  }
}

