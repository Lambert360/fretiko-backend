import { Injectable, UnauthorizedException, CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private supabase;

  constructor(
    private configService: ConfigService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    console.log('🔍 Auth header received:', authHeader ? 'Present' : 'Missing');

    if (!authHeader) {
      throw new UnauthorizedException('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    
    console.log('🔑 Token details:');
    console.log('  - Length:', token.length);
    console.log('  - First 30 chars:', token.substring(0, 30) + '...');
    console.log('  - Ends with:', '...' + token.substring(token.length - 10));
    
    try {
      console.log('🔐 Validating token with Supabase...');
      
      // Let Supabase handle token validation entirely
      const { data: { user }, error } = await this.supabase.auth.getUser(token);
      
      console.log('🔍 Supabase validation result:', { 
        hasUser: !!user, 
        error: error?.message,
        errorCode: error?.code
      });
      
      if (error || !user) {
        console.error('❌ Supabase auth failed:', {
          message: error?.message || 'No user found',
          code: error?.code,
          details: error
        });
        throw new UnauthorizedException('Invalid token');
      }
      
      console.log('✅ Token validated for user:', user.id);
      
      // Attach user to request - trust Supabase completely
      request.user = { sub: user.id, email: user.email };
      request.supabaseUser = user; // Keep full Supabase user object
      request.supabaseToken = token; // Store the raw JWT token for forwarding to Supabase
      return true;
    } catch (error) {
      console.error('💥 Supabase token validation error:', {
        message: error.message,
        name: error.name,
        stack: error.stack?.split('\n')[0]
      });
      throw new UnauthorizedException('Invalid token');
    }
  }
}