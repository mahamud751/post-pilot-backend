import {Global, Module} from '@nestjs/common';
import {BrandController} from './brand.controller';
import {BrandService} from './brand.service';

@Global()
@Module({
  controllers: [BrandController],
  providers: [BrandService],
  exports: [BrandService],
})
export class BrandModule {}
