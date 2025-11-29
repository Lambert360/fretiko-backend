import { Injectable, ExecutionContext, UnauthorizedException, CanActivate } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createServiceSupabaseClient } from '../../shared/supabase.client';

/**
 * Staff JWT Auth Guard
 * Validates custom JWT tokens for staff authentication
 * Verifies token signature and checks if staff account exists and is active
 */
@Injectable()
export class StaffJwtAuthGuard implements CanActivate {
  private supabase;

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      // Verify and decode JWT token
      const payload = this.jwtService.verify(token);
      
      if (!payload || !payload.sub) {
        throw new UnauthorizedException('Invalid token payload');
      }

      // Verify staff account exists and is active
      const { data: staff, error } = await this.supabase
        .from('staff_accounts')
        .select('id, staff_id, email, role, department_id, is_active')
        .eq('id', payload.sub)
        .eq('is_active', true)
        .single();

      if (error) {
        console.error('Staff lookup error:', error);
        throw new UnauthorizedException(`Staff account lookup failed: ${error.message}`);
      }

      if (!staff) {
        throw new UnauthorizedException('Staff account not found or inactive');
      }

      // Attach staff info to request
      request.user = {
        sub: staff.id,
        staffId: staff.staff_id,
        email: staff.email,
        role: staff.role,
        departmentId: staff.department_id,
      };

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      // Log the actual error for debugging
      console.error('StaffJwtAuthGuard error:', error);
      throw new UnauthorizedException(`Authentication failed: ${error.message || 'Invalid or expired token'}`);
    }
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
