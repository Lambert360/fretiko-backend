import { Controller, Post, Get, Patch, Delete, Body, Param, Req, UseGuards, HttpCode, HttpStatus, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StaffService } from './staff.service';
import { StaffJwtAuthGuard } from './guards/staff-jwt-auth.guard';
import { Permissions } from './decorators/permissions.decorator';
import { PermissionsGuard } from './guards/permissions.guard';
import {
  StaffLoginDto,
  CreateStaffDto,
  UpdateStaffDto,
  UpdateMyProfileDto,
  ChangePasswordDto,
  SuspendStaffDto,
  DeleteStaffDto,
} from './dto/staff.dto';

/**
 * Staff Controller
 * Manages internal tool staff accounts and authentication
 */
@Controller('staff')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  /**
   * Staff login
   * POST /staff/login
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: StaffLoginDto) {
    return this.staffService.login(loginDto);
  }

  /**
   * Create new staff account
   * POST /staff
   * Requires: super_admin or HR with create_staff permission
   */
  @Post()
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('create_staff')
  async createStaff(@Body() createDto: CreateStaffDto, @Req() req) {
    return this.staffService.createStaff(createDto, req.user.sub);
  }

  /**
   * Get all staff
   * GET /staff
   * Super admin sees all, department heads see their department
   */
  @Get()
  @UseGuards(StaffJwtAuthGuard)
  async getAllStaff(@Req() req) {
    return this.staffService.getAllStaff(req.user.sub);
  }

  /**
   * Get current staff profile
   * GET /staff/me
   */
  @Get('me')
  @UseGuards(StaffJwtAuthGuard)
  async getMyProfile(@Req() req) {
    return this.staffService.getStaffById(req.user.sub);
  }

  /**
   * Update own profile
   * PATCH /staff/me
   * Allows staff to update their own fullName and email
   * IMPORTANT: This must come before PATCH /staff/:id to avoid route conflict
   */
  @Patch('me')
  @UseGuards(StaffJwtAuthGuard)
  async updateMyProfile(@Body() updateDto: UpdateMyProfileDto, @Req() req) {
    return this.staffService.updateMyProfile(req.user.sub, updateDto);
  }

  /**
   * Change own password
   * PATCH /staff/me/password
   */
  @Patch('me/password')
  @UseGuards(StaffJwtAuthGuard)
  async changePassword(@Body() changePasswordDto: ChangePasswordDto, @Req() req) {
    return this.staffService.changePassword(req.user.sub, changePasswordDto);
  }

  /**
   * Upload profile picture
   * POST /staff/me/avatar
   */
  @Post('me/avatar')
  @UseGuards(StaffJwtAuthGuard)
  @UseInterceptors(FileInterceptor('avatar'))
  async uploadAvatar(@UploadedFile() file: Express.Multer.File, @Req() req) {
    return this.staffService.uploadAvatar(req.user.sub, file);
  }

  /**
   * Get staff by ID
   * GET /staff/:id
   */
  @Get(':id')
  @UseGuards(StaffJwtAuthGuard)
  async getStaffById(@Param('id') id: string) {
    return this.staffService.getStaffById(id);
  }

  /**
   * Update staff account
   * PATCH /staff/:id
   * Requires: super_admin or HR with edit_staff permission
   */
  @Patch(':id')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('edit_staff')
  async updateStaff(@Param('id') id: string, @Body() updateDto: UpdateStaffDto) {
    return this.staffService.updateStaff(id, updateDto);
  }

  /**
   * Suspend staff account
   * POST /staff/:id/suspend
   * Requires: super_admin or HR with edit_staff permission
   */
  @Post(':id/suspend')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('edit_staff')
  async suspendStaff(
    @Param('id') id: string,
    @Body() suspendDto: SuspendStaffDto,
    @Req() req,
  ) {
    return this.staffService.suspendStaff(id, req.user.sub, suspendDto.reason);
  }

  /**
   * Unsuspend staff account
   * POST /staff/:id/unsuspend
   * Requires: super_admin or HR with edit_staff permission
   */
  @Post(':id/unsuspend')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('edit_staff')
  async unsuspendStaff(@Param('id') id: string, @Req() req) {
    return this.staffService.unsuspendStaff(id, req.user.sub);
  }

  /**
   * Delete staff account (permanent removal)
   * DELETE /staff/:id
   * Requires: super_admin or HR with delete_staff permission
   */
  @Delete(':id')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('delete_staff')
  async deleteStaff(
    @Param('id') id: string,
    @Body() deleteDto: DeleteStaffDto,
    @Req() req,
  ) {
    return this.staffService.deleteStaff(id, req.user.sub, deleteDto.reason);
  }

  /**
   * Deactivate staff account (legacy endpoint)
   * PATCH /staff/:id/deactivate
   * Requires: super_admin or HR with edit_staff permission
   */
  @Patch(':id/deactivate')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('edit_staff')
  async deactivateStaff(@Param('id') id: string) {
    return this.staffService.deactivateStaff(id);
  }

  /**
   * Initialize super admin (one-time setup)
   * POST /staff/init-super-admin
   * This endpoint should be protected or removed after initial setup
   */
  @Post('init-super-admin')
  @HttpCode(HttpStatus.CREATED)
  async initializeSuperAdmin(
    @Body() body: { email: string; password: string; fullName: string },
  ) {
    return this.staffService.initializeSuperAdmin(body.email, body.password, body.fullName);
  }
}
