import { Module } from '@nestjs/common';
import { PartAuthenticationService } from './part-authentication.service';
import { PartAuthenticationController } from './part-authentication.controller';

@Module({
  controllers: [PartAuthenticationController],
  providers: [PartAuthenticationService],
})
export class PartAuthenticationModule {}
