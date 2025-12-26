import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';

/**
 * Suspended User Guard
 * Allows suspended users to access only specific endpoints (account status, appeals)
 * Blocks access to all other endpoints
 * 
 * Industry standard: Suspended users can authenticate but have restricted access
 */
@Injectable()
export class SuspendedUserGuard implements CanActivate {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.sub) {
      // If not authenticated, let JwtAuthGuard handle it
      return true;
    }

    // Check if user is suspended
    const { data: profile } = await this.supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', user.sub)
      .single();

    if (!profile) {
      return true; // Let other guards handle missing profile
    }

    const isSuspended = profile.preferences?.isSuspended === true;
    const isDeleted = profile.preferences?.isDeleted === true;

    // Deleted users cannot access anything
    if (isDeleted) {
      throw new ForbiddenException('This account has been deleted');
    }

    // Suspended users can only access limited endpoints
    // Check the route path to determine if it's an allowed endpoint
    const url = request.url || '';
    const method = request.method || '';
    
    // Allowed endpoints for suspended users
    const allowedEndpoints = [
      { path: '/users/me/account-status', method: 'GET' },
      { path: '/users/me/appeals', method: 'GET' },
      { path: '/users/me/appeals', method: 'POST' },
      { path: '/users/me/appeals/status', method: 'GET' },
      { path: '/users/profile', method: 'GET' }, // Allow viewing own profile
    ];

    const isAllowedRoute = allowedEndpoints.some(endpoint => 
      url.includes(endpoint.path) && method === endpoint.method
    );

    if (isSuspended && !isAllowedRoute) {
      throw new ForbiddenException('Your account has been suspended. You can only access account status, appeals, and your profile.');
    }

    return true;
  }
}

