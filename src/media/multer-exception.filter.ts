import {ArgumentsHost, Catch, ExceptionFilter} from '@nestjs/common';
import {Response} from 'express';
import {MulterError} from 'multer';

@Catch(MulterError)
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception.code === 'LIMIT_FILE_SIZE') {
      response.status(413).json({
        message: 'File is too large. Please upload a smaller image or video.',
        error: 'Payload Too Large',
        statusCode: 413,
      });
      return;
    }

    response.status(400).json({
      message: exception.message,
      error: 'Bad Request',
      statusCode: 400,
    });
  }
}
