import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { createServiceSupabaseClient } from '../../shared/supabase.client';

/**
 * Permissions Guard
 * Checks if staff has required permissions based on their role and department
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);
  private supabase;

  constructor(
    private reflector: Reflector,
    private configService: ConfigService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Get required permissions from decorator
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true; // No permissions required
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.sub) {
      throw new ForbiddenException('User not authenticated');
    }

    // Get staff details with department permissions
    const { data: staff, error } = await this.supabase
      .from('staff_accounts')
      .select(`
        id,
        staff_id,
        role,
        is_active,
        department_id,
        department:departments(
          id,
          name,
          slug,
          permissions
        )
      `)
      .eq('id', user.sub)
      .single();

    if (error || !staff) {
      this.logger.warn(`Staff not found for ID: ${user.sub}`);
      throw new ForbiddenException('Staff not found');
    }

    if (!staff.is_active) {
      this.logger.warn(`Inactive staff attempted access: ${staff.staff_id}`);
      throw new ForbiddenException('Staff account is inactive');
    }

    // Super admin has all permissions
    if (staff.role === 'super_admin') {
      return true;
    }

    // Get department permissions
    const departmentPermissions: string[] = staff.department?.permissions || [];

    // Check if staff has ALL required permissions
    const hasAllPermissions = requiredPermissions.every(permission =>
      departmentPermissions.includes(permission)
    );

    if (!hasAllPermissions) {
      this.logger.warn(
        `Permission denied for staff ${staff.staff_id}. Required: ${requiredPermissions.join(', ')}. Has: ${departmentPermissions.join(', ')}`
      );
      throw new ForbiddenException('Insufficient permissions');
    }

    // Attach staff details to request for use in controllers
    request.staff = staff;

    return true;
  }
}
