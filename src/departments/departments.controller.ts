import { Controller, Post, Get, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';

/**
 * Departments Controller
 * Manages departments and permissions
 */
@Controller('departments')
@UseGuards(StaffJwtAuthGuard)
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  /**
   * Get all departments
   * GET /departments
   */
  @Get()
  async getAllDepartments() {
    return this.departmentsService.getAllDepartments();
  }

  /**
   * Get all available permissions
   * GET /departments/permissions
   */
  @Get('permissions')
  async getAllPermissions() {
    return this.departmentsService.getAllPermissions();
  }

  /**
   * Get department by ID
   * GET /departments/:id
   */
  @Get(':id')
  async getDepartmentById(@Param('id') id: string) {
    return this.departmentsService.getDepartmentById(id);
  }

  /**
   * Create new department
   * POST /departments
   * Requires: super_admin only
   */
  @Post()
  @UseGuards(PermissionsGuard)
  @Permissions('manage_departments')
  async createDepartment(@Body() createDto: CreateDepartmentDto) {
    return this.departmentsService.createDepartment(createDto);
  }

  /**
   * Update department
   * PATCH /departments/:id
   * Requires: super_admin only
   */
  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @Permissions('manage_departments')
  async updateDepartment(@Param('id') id: string, @Body() updateDto: UpdateDepartmentDto) {
    return this.departmentsService.updateDepartment(id, updateDto);
  }
}
