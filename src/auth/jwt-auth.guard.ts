import { Injectable, UnauthorizedException, CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { createSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private supabase;
  private jwtService: JwtService;

  constructor(
    private configService: ConfigService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
    // Create JWT service instance directly to avoid injection issues
    this.jwtService = new JwtService({
      secret: this.configService.get<string>('JWT_SECRET'),
      signOptions: { expiresIn: '7d' },
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    console.log(' Auth header received:', authHeader ? 'Present' : 'Missing');

    if (!authHeader) {
      throw new UnauthorizedException('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');

    console.log(' Token details:');
    console.log('  - Length:', token.length);
    console.log('  - First 30 chars:', token.substring(0, 30) + '...');
    console.log('  - Ends with:', '...' + token.substring(token.length - 10));

    try {
      console.log(' Validating custom JWT with our secret...');

      const decoded = this.jwtService.verify(token);

      console.log(' Custom JWT validated for user:', decoded.sub);

      // Get user from Supabase for profile data (optional)
      const { data: supabaseUser, error: supabaseError } = await this.supabase.auth.admin.getUserById(
        decoded.sub
      );

      if (supabaseError) {
        console.error(' Could not fetch user profile:', supabaseError.message);
      }

      // Attach user to request
      request.user = { 
        sub: decoded.sub, 
        email: decoded.email || supabaseUser?.email,
        type: decoded.type,
        iat: decoded.iat,
        exp: decoded.exp
      };

      request.supabaseUser = supabaseUser;
      request.supabaseToken = token;

      return true;
    } catch (error) {
      console.error(' Custom JWT validation failed:', {
        message: error.message,
        name: error.name,
        stack: error.stack?.split('\n')[0]
      });

      throw new UnauthorizedException('Invalid token');
    }
  }
}