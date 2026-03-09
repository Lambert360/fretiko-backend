import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { createSupabaseClient } from '../shared/supabase.client';



/**

 * Optional JWT Auth Guard

 * Attempts to validate JWT token if present, but allows request to continue if not

 * Useful for endpoints that work for both authenticated and unauthenticated users

 */

@Injectable()

export class OptionalJwtAuthGuard implements CanActivate {

  private supabase;



  constructor(private configService: ConfigService) {

    this.supabase = createSupabaseClient(this.configService);

  }



  async canActivate(context: ExecutionContext): Promise<boolean> {

    const request = context.switchToHttp().getRequest();

    const authHeader = request.headers.authorization;



    // If no auth header, allow request to continue but without user info

    if (!authHeader) {

      console.log('🔓 Optional auth: No authorization header, continuing without user');

      return true;

    }



    const token = authHeader.replace('Bearer ', '');



    try {

      console.log('🔐 Optional auth: Validating token with Supabase...');



      // Let Supabase handle token validation

      const { data: { user }, error } = await this.supabase.auth.getUser(token);



      if (error || !user) {

        // Log warning but don't throw - allow request to continue without user

        console.warn('⚠️ Optional auth: Token validation failed, continuing without user:', error?.message);

        return true;

      }



      console.log('✅ Optional auth: Token validated for user:', user.id);



      // Attach user to request

      request.user = { sub: user.id, email: user.email };

      request.supabaseUser = user;

      request.supabaseToken = token;

      return true;

    } catch (error) {

      // Log error but don't throw - allow request to continue without user

      console.warn('⚠️ Optional auth: Token validation error, continuing without user:', error.message);

      return true;

    }

  }

}

