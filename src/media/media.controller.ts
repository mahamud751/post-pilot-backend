import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {ApiBearerAuth, ApiConsumes, ApiTags} from '@nestjs/swagger';
import {diskStorage} from 'multer';
import {mkdirSync} from 'fs';
import {extname} from 'path';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {MediaService} from './media.service';
import {MulterExceptionFilter} from './multer-exception.filter';

const maxFileSize = Number(process.env.MAX_FILE_SIZE ?? 524288000);
const uploadDir = 'uploads';
const allowedMimePrefixes = ['image/', 'video/'];

const storage = diskStorage({
  destination: (_req, _file, callback) => {
    mkdirSync(uploadDir, {recursive: true});
    callback(null, uploadDir);
  },
  filename: (_req, file, callback) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    callback(null, `${unique}${extname(file.originalname)}`);
  },
});

@ApiTags('media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('upload')
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
    @CurrentUserId() userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.mediaService.save(userId, file);
  }
}
