import { 
  Controller, 
  Get, 
  Post, 
  Put, 
  Delete, 
  Body, 
  Param, 
  Query,
  UseGuards,
  Request,
  HttpStatus,
  HttpCode
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { StaffJwtAuthGuard } from '../../staff/guards/staff-jwt-auth.guard';
import { SupportMessagesService } from '../services/support-messages.service';
import { CreateSupportMessageDto, UpdateSupportMessageDto, SupportMessageReplyDto, SupportMessageQueryDto } from '../dto/support-message.dto';

@ApiTags('Website Content - Support Messages')
@Controller('admin/website-content/support-messages')
@UseGuards(StaffJwtAuthGuard)
export class SupportMessagesController {
  constructor(private readonly supportMessagesService: SupportMessagesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all support messages' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Support messages retrieved successfully' })
  async findAll(@Query() query: SupportMessageQueryDto) {
    return this.supportMessagesService.findAll(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get support messages statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Statistics retrieved successfully' })
  async getStats() {
    const [overallStats, typeStats, staffStats] = await Promise.all([
      this.supportMessagesService.getSupportStats(),
      this.supportMessagesService.getTypeStats(),
      this.supportMessagesService.getStaffStats(),
    ]);

    return {
      ...overallStats,
      types: typeStats,
      staff: staffStats,
    };
  }

  @Get('recent')
  @ApiOperation({ summary: 'Get recent support messages' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Recent messages retrieved successfully' })
  async getRecent(@Query('limit') limit?: number) {
    return this.supportMessagesService.getRecentMessages(limit || 10);
  }

  @Get('types')
  @ApiOperation({ summary: 'Get support message type statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Type statistics retrieved successfully' })
  async getTypeStats() {
    return this.supportMessagesService.getTypeStats();
  }

  @Get('staff')
  @ApiOperation({ summary: 'Get staff assignment statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Staff statistics retrieved successfully' })
  async getStaffStats() {
    return this.supportMessagesService.getStaffStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get support message by ID' })
  @ApiParam({ name: 'id', description: 'Support message ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Support message retrieved successfully' })
  async findById(@Param('id') id: string) {
    return this.supportMessagesService.findById(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update support message' })
  @ApiParam({ name: 'id', description: 'Support message ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Support message updated successfully' })
  async update(
    @Param('id') id: string,
    @Body() updateSupportMessageDto: UpdateSupportMessageDto
  ) {
    return this.supportMessagesService.update(id, updateSupportMessageDto);
  }

  @Put(':id/reply')
  @ApiOperation({ summary: 'Reply to support message' })
  @ApiParam({ name: 'id', description: 'Support message ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Reply sent successfully' })
  async reply(
    @Param('id') id: string,
    @Body() replyDto: SupportMessageReplyDto,
    @Request() req: any
  ) {
    return this.supportMessagesService.reply(id, replyDto, req.user.id);
  }

  @Put(':id/assign/:staffId')
  @ApiOperation({ summary: 'Assign support message to staff' })
  @ApiParam({ name: 'id', description: 'Support message ID' })
  @ApiParam({ name: 'staffId', description: 'Staff member ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Message assigned successfully' })
  async assignToStaff(
    @Param('id') id: string,
    @Param('staffId') staffId: string
  ) {
    return this.supportMessagesService.assignToStaff(id, staffId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete support message' })
  @ApiParam({ name: 'id', description: 'Support message ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Support message deleted successfully' })
  async remove(@Param('id') id: string) {
    return this.supportMessagesService.remove(id);
  }
}

// Public controller for website frontend
@ApiTags('Public - Support Messages')
@Controller('public/website-content/support-messages')
export class PublicSupportMessagesController {
  constructor(private readonly supportMessagesService: SupportMessagesService) {}

  @Post()
  @ApiOperation({ summary: 'Submit support message' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Support message submitted successfully' })
  async create(@Body() createSupportMessageDto: CreateSupportMessageDto) {
    return this.supportMessagesService.create(createSupportMessageDto);
  }
}
