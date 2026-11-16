import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {ApiBearerAuth, ApiConsumes, ApiHeader, ApiTags} from '@nestjs/swagger';
import {ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength} from 'class-validator';
import type {Response} from 'express';
import {mkdirSync} from 'fs';
import {diskStorage} from 'multer';
import {randomUUID} from 'crypto';
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
import {TMP_DIR} from './media-storage';
import {MediaQuery, MediaService} from './media.service';
import {MulterExceptionFilter} from './multer-exception.filter';

const maxFileSize = Number(process.env.MAX_FILE_SIZE ?? 524288000);
const allowedMimePrefixes = ['image/', 'video/'];

const storage = diskStorage({
  destination: (_req, _file, callback) => {
    mkdirSync(TMP_DIR, {recursive: true});
    callback(null, TMP_DIR);
  },
  filename: (_req, _file, callback) => callback(null, randomUUID()),
});

class UpdateMediaDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  folder?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({each: true})
  @MaxLength(40, {each: true})
  tags?: string[];
}

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('upload')
  @ApiBearerAuth()
  @ApiHeader({name: WORKSPACE_HEADER, required: false})
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  @RequireRoles(...CONTENT_WRITERS)
  @ApiConsumes('multipart/form-data')
  @UseFilters(MulterExceptionFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      storage,
      limits: {fileSize: maxFileSize},
      fileFilter: (_req, file, callback) => {
        const isAllowed = allowedMimePrefixes.some(prefix =>
          String(file.mimetype || '').startsWith(prefix),
        );
        if (!isAllowed) {
          callback(new BadRequestException('Only image and video uploads are allowed.'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  upload(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.mediaService.save(ctx.id, userId, file);
  }

  @Get()
  @ApiBearerAuth()
  @ApiHeader({name: WORKSPACE_HEADER, required: false})
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  list(@CurrentWorkspace() ctx: WorkspaceContext, @Query() query: MediaQuery) {
    return this.mediaService.list(ctx.id, query);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  @RequireRoles(...CONTENT_WRITERS)
  update(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: UpdateMediaDto,
  ) {
    return this.mediaService.update(ctx.id, userId, id, input);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  @RequireRoles(...CONTENT_WRITERS)
  remove(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
  ) {
    return this.mediaService.remove(ctx.id, userId, id);
  }

  /** Signed, expiring file access; also how Meta fetches media at publish time. */
  @Get('files/:workspaceId/:name')
  file(
    @Param('workspaceId') workspaceId: string,
    @Param('name') name: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    const path = this.mediaService.resolveSignedFile(`${workspaceId}/${name}`, exp, sig);
    if (!path) {
      throw new NotFoundException('File not found or link expired');
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(path);
  }
}
