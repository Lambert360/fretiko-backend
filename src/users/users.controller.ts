import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { UpdateProfileDto } from '../shared/dto/user-profile.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SuspendedUserGuard } from '../auth/suspended-user.guard';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('profile')
  @UseGuards(JwtAuthGuard, SuspendedUserGuard)
  async getMyProfile(@Request() req) {
    return this.usersService.getProfile(req.user.sub);
  }

  @Get('profile/:id')
  async getPublicProfile(@Param('id') id: string) {
    return this.usersService.getPublicProfile(id);
  }

  @Put('profile')
  @UseGuards(JwtAuthGuard)
  async updateProfile(@Request() req, @Body() updateData: UpdateProfileDto) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    return this.usersService.updateProfile(req.user.sub, updateData, token);
  }

  @Post('avatar')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('avatar', {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: (req, file, cb) => {
      // Only allow images
      if (file.mimetype.match(/\/(jpg|jpeg|png|gif|webp)$/)) {
        cb(null, true);
      } else {
        cb(new BadRequestException('Only image files are allowed'), false);
      }
    },
  }))
  async uploadAvatar(@Request() req, @UploadedFile() file: any) {
    console.log('📁 Avatar upload endpoint hit');
    console.log('📋 Request headers:', Object.keys(req.headers));
    console.log('📂 File received:', !!file);
    console.log('📂 File details:', file ? {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    } : 'No file');
    
    if (!file) {
      console.error('❌ No file in request');
      throw new BadRequestException('No file uploaded');
    }

    const token = req.headers.authorization?.replace('Bearer ', '');
    const avatarUrl = await this.usersService.uploadAvatar(
      req.user.sub,
      file.buffer,
      file.originalname,
      token
    );

    return { avatarUrl, message: 'Avatar uploaded successfully' };
  }

  @Post('background')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('background', {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB limit for background images
    },
    fileFilter: (req, file, cb) => {
      // Only allow images
      if (file.mimetype.match(/\/(jpg|jpeg|png|gif|webp)$/)) {
        cb(null, true);
      } else {
        cb(new BadRequestException('Only image files are allowed'), false);
      }
    },
  }))
  async uploadBackground(@Request() req, @UploadedFile() file: any) {
    console.log('📁 Background upload endpoint hit');
    console.log('📋 Request headers:', Object.keys(req.headers));
    console.log('📂 File received:', !!file);
    console.log('📂 File details:', file ? {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    } : 'No file');
    
    if (!file) {
      console.error('❌ No file in request');
      throw new BadRequestException('No file uploaded');
    }

    const token = req.headers.authorization?.replace('Bearer ', '');
    const bgPicUrl = await this.usersService.uploadBackground(
      req.user.sub,
      file.buffer,
      file.originalname,
      token
    );

    return { bgPicUrl, message: 'Background image uploaded successfully' };
  }

  @Get('search')
  async searchUsers(@Query('q') query: string, @Query('limit') limit: string = '20') {
    if (!query || query.trim().length === 0) {
      throw new BadRequestException('Search query is required');
    }

    return this.usersService.searchUsers(query.trim(), parseInt(limit));
  }

  @Delete('account')
  @UseGuards(JwtAuthGuard)
  async deleteAccount(@Request() req) {
    console.log('🗑️ Account deletion requested by user:', req.user.sub);
    const token = req.headers.authorization?.replace('Bearer ', '');
    return this.usersService.deleteAccount(req.user.sub, token);
  }

  /**
   * Get current user's warnings
   * GET /users/me/warnings
   * Requires: User authentication
   */
  @Get('me/warnings')
  @UseGuards(JwtAuthGuard)
  async getMyWarnings(@Request() req) {
    return this.usersService.getMyWarnings(req.user.sub);
  }

  /**
   * Get current user's account status
   * GET /users/me/account-status
   * Requires: User authentication
   */
  @Get('me/account-status')
  @UseGuards(JwtAuthGuard, SuspendedUserGuard)
  async getAccountStatus(@Request() req) {
    return this.usersService.getAccountStatus(req.user.sub);
  }

  /**
   * Submit a suspension appeal
   * POST /users/me/appeals
   * Requires: User authentication (suspended users allowed)
   */
  @Post('me/appeals')
  @UseGuards(JwtAuthGuard, SuspendedUserGuard)
  async submitAppeal(@Request() req, @Body() body: { reason: string }) {
    // Pass authenticated user ID for security validation
    return this.usersService.submitAppeal(req.user.sub, body.reason, req.user.sub);
  }

  /**
   * Get current user's appeals
   * GET /users/me/appeals
   * Requires: User authentication (suspended users allowed)
   */
  @Get('me/appeals')
  @UseGuards(JwtAuthGuard, SuspendedUserGuard)
  async getMyAppeals(@Request() req) {
    // Pass authenticated user ID for security validation
    return this.usersService.getMyAppeals(req.user.sub, req.user.sub);
  }

  /**
   * Get current user's appeal status
   * GET /users/me/appeals/status
   * Requires: User authentication (suspended users allowed)
   */
  @Get('me/appeals/status')
  @UseGuards(JwtAuthGuard, SuspendedUserGuard)
  async getAppealStatus(@Request() req) {
    // Pass authenticated user ID for security validation
    return this.usersService.getAppealStatus(req.user.sub, req.user.sub);
  }
}