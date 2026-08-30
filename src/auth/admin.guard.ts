import { Injectable, UnauthorizedException, ForbiddenException, CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';

/**
 * Admin Guard
 * Verifies that the authenticated user has admin privileges
 * Checks user_profiles.role === 'admin' or preferences.isAdmin === true
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.sub;

    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }

    // Check if user has admin role
    const { data: profile, error } = await this.supabase
      .from('user_profiles')
      .select('role, preferences')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      throw new ForbiddenException('User profile not found');
    }

    const adminRoles = ['admin', 'super_admin', 'superadmin'];
    const isAdmin = adminRoles.includes(profile.role) || profile.preferences?.isAdmin === true;

    if (!isAdmin) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}

