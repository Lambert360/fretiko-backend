import { Controller, Post, Body } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { AuthService } from './auth.service';
import { SignUpDto, SignInDto, MigrateAccountDto } from '../shared/dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @MessagePattern('ping')
  ping() {
    return 'Auth microservice is alive!';
  }

  @Post('signup')
  async signUp(@Body() signUpDto: SignUpDto) {
    return this.authService.signUp(signUpDto);
  }

  @Post('signin')
  async signIn(@Body() signInDto: SignInDto) {
    return this.authService.signIn(signInDto);
  }

  @Post('migrate')
  async migrateAccount(@Body() migrateDto: MigrateAccountDto) {
    return this.authService.migrateAccount(migrateDto.email, migrateDto.newPassword);
  }

  // Microservice message patterns (for inter-service communication)
  @MessagePattern('auth.signup')
  async handleSignUp(data: SignUpDto) {
    return this.authService.signUp(data);
  }

  @MessagePattern('auth.signin')
  async handleSignIn(data: SignInDto) {
    return this.authService.signIn(data);
  }
}