import { Injectable, ExecutionContext, UnauthorizedException, CanActivate } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createSupabaseClient } from '../shared/supabase.client';
import { createServiceSupabaseClient } from '../shared/supabase.client';

/**
 * Hybrid Admin Guard
 * Supports both regular admin users (Supabase JWT) and staff users (Custom JWT)
 * Routes to appropriate authentication method based on token format
 */
@Injectable()
export class HybridAdminGuard implements CanActivate {
  private supabase;
  private serviceSupabase;

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('No authorization header');
    }

    // Try staff authentication first (custom JWT)
    let staffAuthError: any = null;
    try {
      const staffPayload = this.jwtService.verify(token);

      if (staffPayload && staffPayload.sub) {
        // Verify staff account exists and is active
        const { data: staff, error } = await this.serviceSupabase
          .from('staff_accounts')
          .select('id, staff_id, email, role, department_id, is_active')
          .eq('id', staffPayload.sub)
          .eq('is_active', true)
          .single();

        if (!error && staff) {
          // For staff users, check if they have view_revenue permission (required for gift management)
          if (staff.role !== 'super_admin') {
            const { data: department, error: deptError } = await this.serviceSupabase
              .from('departments')
              .select('permissions')
              .eq('id', staff.department_id)
              .single();

            if (deptError || !department) {
              throw new UnauthorizedException('Staff department not found');
            }

            const permissions: string[] = department.permissions || [];
            if (!permissions.includes('view_revenue')) {
              throw new UnauthorizedException('Staff user requires view_revenue permission for gift management');
            }
          }

          // Attach staff info to request
          request.user = {
            sub: staff.id,
            staffId: staff.staff_id,
            email: staff.email,
            role: staff.role,
            departmentId: staff.department_id,
            isStaff: true,
          };
          request.authType = 'staff';
          return true;
        }
      }
    } catch (error: any) {
      staffAuthError = error;
      // Staff JWT failed, try regular user authentication
    }

    // Try regular user authentication (Supabase JWT)
    try {
      const { data: { user }, error } = await this.supabase.auth.getUser(token);

      if (error || !user) {
        throw new UnauthorizedException('Invalid token');
      }

      // Attach user to request
      request.user = {
        sub: user.id,
        email: user.email,
        isStaff: false,
      };
      request.supabaseUser = user;
      request.supabaseToken = token;
      request.authType = 'user';

      return true;
    } catch (userError: any) {
      console.error('Both authentication methods failed:', {
        staffError: staffAuthError?.message,
        userError: userError.message
      });
      throw new UnauthorizedException('Authentication failed for both staff and regular users');
    }
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
