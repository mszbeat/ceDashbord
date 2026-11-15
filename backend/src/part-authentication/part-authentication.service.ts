import { Injectable } from '@nestjs/common';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class PartAuthenticationService {

  private configs = {
    
  }

  async register(body: RegisterDto) {
    const payload = { ...body };
    return payload;
  }

}
