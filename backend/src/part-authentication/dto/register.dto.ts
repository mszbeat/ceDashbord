import { IsNotEmpty, IsString, MinLength } from "class-validator";

export class RegisterDto {
  @IsNotEmpty({ message: "نام کاربری نمی تواند خالی باشد." })
  @IsString({ message: "نام کاربری باید رشته باشد." })
  @MinLength(3,{ message: "نام کاربری باید بیشتر از 3 کاراکتر باشد." })
  username: string;
  
  @IsNotEmpty({ message: "رمز عبور نمی تواند خالی باشد." })
  @IsString({ message: "رمز عبور باید رشته باشد." })
  @MinLength(8,{ message: "رمز عبور باید بیشتر از 8 کاراکتر باشد." })
  pass: string;
}
