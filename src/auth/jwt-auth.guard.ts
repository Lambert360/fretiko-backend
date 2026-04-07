import { Injectable, UnauthorizedException, CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { createSupabaseClient } from '../shared/supabase.client';
import { RequestWithUser, JwtPayload } from '../shared/types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private supabase;

  constructor(
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
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

      const decoded = this.jwtService.verify(token) as any;
      
      if (!decoded || typeof decoded !== 'object') {
        throw new Error('Invalid token payload');
      }

      console.log(' Custom JWT validated for user:', decoded.sub);

      // Get user from Supabase for profile data (optional)
      let supabaseUser: any = null;
      try {
        const { data, error: supabaseError } = await this.supabase.auth.admin.getUserById(
          (decoded as any).sub
        );
        
        if (!supabaseError) {
          supabaseUser = data;
        }
      } catch (error) {
        console.log('⚠️ Could not fetch user profile from Supabase (expected with custom JWT)');
      }

      // Attach user to request
      request.user = { 
        sub: (decoded as any).sub,
        id: (decoded as any).sub, // Use sub as id since they're the same in our system
        email: (decoded as any).email ?? (supabaseUser?.email || undefined),
        type: (decoded as any).type,
        iat: (decoded as any).iat,
        exp: (decoded as any).exp
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