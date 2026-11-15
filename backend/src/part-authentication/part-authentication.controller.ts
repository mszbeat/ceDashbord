import { Body, Controller, Post } from '@nestjs/common';
import { PartAuthenticationService } from './part-authentication.service';
import { RegisterDto } from './dto/register.dto';

@Controller('part-authentication')
export class PartAuthenticationController {
  constructor(private readonly partAuthenticationService: PartAuthenticationService) { }

  @Post('register')
  async register(@Body() body: RegisterDto) {
    this.partAuthenticationService.register(body);
  }
}
