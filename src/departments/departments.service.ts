import { Injectable, Logger, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { CreateDepartmentDto, UpdateDepartmentDto, DepartmentResponseDto } from './dto/department.dto';

/**
 * Departments Service
 * Manages departments and their permissions
 */
@Injectable()
export class DepartmentsService {
  private readonly logger = new Logger(DepartmentsService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Get all departments
   */
  async getAllDepartments(): Promise<DepartmentResponseDto[]> {
    const { data: departments, error } = await this.supabase
      .from('departments')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      this.logger.error(`Failed to fetch departments: ${error.message}`);
      throw new BadRequestException('Failed to fetch departments');
    }

    if (!departments || departments.length === 0) {
      return [];
    }

    // Get staff count for each department
    const departmentsWithCount = await Promise.all(
      departments.map(async (dept) => {
        const { count, error: countError } = await this.supabase
          .from('staff_accounts')
          .select('*', { count: 'exact', head: true })
          .eq('department_id', dept.id)
          .eq('is_active', true);

        if (countError) {
          this.logger.warn(`Failed to get staff count for department ${dept.id}: ${countError.message}`);
        }

        return {
          ...dept,
          staff_count: count || 0,
        };
      })
    );

    return departmentsWithCount.map(dept => this.mapToResponseDto(dept));
  }

  /**
   * Get department by ID
   */
  async getDepartmentById(id: string): Promise<DepartmentResponseDto> {
    const { data: department, error } = await this.supabase
      .from('departments')
      .select(`
        *,
        staff_count:staff_accounts(count)
      `)
      .eq('id', id)
      .single();

    if (error || !department) {
      throw new NotFoundException('Department not found');
    }

    return this.mapToResponseDto(department);
  }

  /**
   * Get department by slug
   */
  async getDepartmentBySlug(slug: string): Promise<DepartmentResponseDto> {
    const { data: department, error } = await this.supabase
      .from('departments')
      .select(`
        *,
        staff_count:staff_accounts(count)
      `)
      .eq('slug', slug)
      .single();

    if (error || !department) {
      throw new NotFoundException('Department not found');
    }

    return this.mapToResponseDto(department);
  }

  /**
   * Create new department
   * Only super_admin can create departments
   */
  async createDepartment(createDto: CreateDepartmentDto): Promise<DepartmentResponseDto> {
    // Check if slug already exists
    const { data: existing } = await this.supabase
      .from('departments')
      .select('id')
      .eq('slug', createDto.slug)
      .single();

    if (existing) {
      throw new ConflictException('Department slug already exists');
    }

    const { data: newDepartment, error } = await this.supabase
      .from('departments')
      .insert({
        name: createDto.name,
        slug: createDto.slug,
        description: createDto.description || null,
        permissions: createDto.permissions || [],
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to create department: ${error.message}`);
      throw new BadRequestException('Failed to create department');
    }

    this.logger.log(`Department created: ${newDepartment.name}`);

    return this.mapToResponseDto(newDepartment);
  }

  /**
   * Update department
   * Only super_admin can update departments
   */
  async updateDepartment(id: string, updateDto: UpdateDepartmentDto): Promise<DepartmentResponseDto> {
    const updateData: any = {};

    if (updateDto.name) updateData.name = updateDto.name;
    if (updateDto.description !== undefined) updateData.description = updateDto.description;
    if (updateDto.permissions) updateData.permissions = updateDto.permissions;
    if (updateDto.isActive !== undefined) updateData.is_active = updateDto.isActive;

    const { data: updatedDepartment, error } = await this.supabase
      .from('departments')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to update department: ${error.message}`);
      throw new BadRequestException('Failed to update department');
    }

    this.logger.log(`Department updated: ${updatedDepartment.name}`);

    return this.mapToResponseDto(updatedDepartment);
  }

  /**
   * Get all available permissions
   */
  async getAllPermissions(): Promise<Array<{ code: string; name: string; category: string; description: string }>> {
    const permissions = [
      // Users Management
      { code: 'view_users', name: 'View Users', category: 'users', description: 'View user profiles and details' },
      { code: 'suspend_users', name: 'Suspend Users', category: 'users', description: 'Suspend or unsuspend user accounts' },
      { code: 'delete_users', name: 'Delete Users', category: 'users', description: 'Delete user accounts (soft delete)' },
      { code: 'edit_users', name: 'Edit Users', category: 'users', description: 'Edit user profile information' },

      // Orders & Transactions
      { code: 'view_orders', name: 'View Orders', category: 'orders', description: 'View order details and history' },
      { code: 'view_transactions', name: 'View Transactions', category: 'orders', description: 'View transaction logs' },
      { code: 'manage_refunds', name: 'Manage Refunds', category: 'orders', description: 'Process refunds for orders' },
      { code: 'manage_escrow', name: 'Manage Escrow', category: 'orders', description: 'Manage escrow holdings and releases' },

      // Content Moderation
      { code: 'view_products', name: 'View Products', category: 'content', description: 'View product listings' },
      { code: 'approve_products', name: 'Approve Products', category: 'content', description: 'Approve pending products' },
      { code: 'remove_products', name: 'Remove Products', category: 'content', description: 'Remove inappropriate products' },
      { code: 'view_services', name: 'View Services', category: 'content', description: 'View service listings' },
      { code: 'approve_services', name: 'Approve Services', category: 'content', description: 'Approve pending services' },
      { code: 'remove_services', name: 'Remove Services', category: 'content', description: 'Remove inappropriate services' },
      { code: 'view_stories', name: 'View Stories', category: 'content', description: 'View user stories' },
      { code: 'remove_stories', name: 'Remove Stories', category: 'content', description: 'Remove inappropriate stories' },
      { code: 'view_live_streams', name: 'View Live Streams', category: 'content', description: 'Monitor live streams' },
      { code: 'end_live_streams', name: 'End Live Streams', category: 'content', description: 'Terminate inappropriate live streams' },

      // Disputes
      { code: 'view_disputes', name: 'View Disputes', category: 'disputes', description: 'View dispute details' },
      { code: 'resolve_disputes', name: 'Resolve Disputes', category: 'disputes', description: 'Resolve buyer-seller disputes' },
      { code: 'escalate_disputes', name: 'Escalate Disputes', category: 'disputes', description: 'Escalate disputes to higher authority' },

      // Finance
      { code: 'view_revenue', name: 'View Revenue', category: 'finance', description: 'View platform revenue and analytics' },
      { code: 'view_wallet_transactions', name: 'View Wallet Transactions', category: 'finance', description: 'View wallet transaction history' },
      { code: 'process_payouts', name: 'Process Payouts', category: 'finance', description: 'Process vendor/rider payouts' },

      // Logistics
      { code: 'view_riders', name: 'View Riders', category: 'logistics', description: 'View rider profiles' },
      { code: 'manage_riders', name: 'Manage Riders', category: 'logistics', description: 'Manage rider accounts and status' },
      { code: 'view_deliveries', name: 'View Deliveries', category: 'logistics', description: 'View delivery tracking' },
      { code: 'assign_deliveries', name: 'Assign Deliveries', category: 'logistics', description: 'Assign deliveries to riders' },

      // Analytics
      { code: 'view_platform_stats', name: 'View Platform Stats', category: 'analytics', description: 'View platform-wide statistics' },
      { code: 'view_user_growth', name: 'View User Growth', category: 'analytics', description: 'View user growth analytics' },
      { code: 'export_data', name: 'Export Data', category: 'analytics', description: 'Export reports and data' },

      // Staff Management
      { code: 'create_staff', name: 'Create Staff', category: 'staff', description: 'Create new staff accounts' },
      { code: 'edit_staff', name: 'Edit Staff', category: 'staff', description: 'Edit staff account details' },
      { code: 'delete_staff', name: 'Delete Staff', category: 'staff', description: 'Deactivate staff accounts' },
      { code: 'assign_permissions', name: 'Assign Permissions', category: 'staff', description: 'Assign permissions to staff' },
      { code: 'view_staff_logs', name: 'View Staff Logs', category: 'staff', description: 'View staff audit logs' },
      { code: 'manage_departments', name: 'Manage Departments', category: 'staff', description: 'Create and manage departments' },

      // Communication
      { code: 'send_memos', name: 'Send Memos', category: 'communication', description: 'Send memos to staff/departments' },
      { code: 'view_memos', name: 'View Memos', category: 'communication', description: 'View received memos' },
      { code: 'create_reports', name: 'Create Reports', category: 'communication', description: 'Create and submit reports' },
      { code: 'view_reports', name: 'View Reports', category: 'communication', description: 'View department reports' },
    ];

    return permissions;
  }

  /**
   * Map database record to response DTO
   */
  private mapToResponseDto(dept: any): DepartmentResponseDto {
    return {
      id: dept.id,
      name: dept.name,
      slug: dept.slug,
      description: dept.description,
      permissions: Array.isArray(dept.permissions) ? dept.permissions : [],
      isActive: dept.is_active !== false, // Default to true if not set
      createdAt: dept.created_at,
      updatedAt: dept.updated_at,
      staffCount: typeof dept.staff_count === 'number' ? dept.staff_count : 0,
    };
  }
}
