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
  HttpStatus,
  HttpCode
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { StaffJwtAuthGuard } from '../../staff/guards/staff-jwt-auth.guard';
import { AboutContentService } from '../services/about-content.service';
import { CreateAboutContentDto, UpdateAboutContentDto, UpdateOrderDto } from '../dto/about-content.dto';

@ApiTags('Website Content - About')
@Controller('admin/website-content/about-content')
@UseGuards(StaffJwtAuthGuard)
export class AboutContentController {
  constructor(private readonly aboutContentService: AboutContentService) {}

  @Get()
  @ApiOperation({ summary: 'Get all about content sections' })
  @ApiResponse({ status: HttpStatus.OK, description: 'About content sections retrieved successfully' })
  async findAll() {
    return this.aboutContentService.findAll();
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get about content statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Statistics retrieved successfully' })
  async getStats() {
    return this.aboutContentService.getSectionStats();
  }

  @Get('section/:section')
  @ApiOperation({ summary: 'Get about content by section' })
  @ApiParam({ name: 'section', description: 'Section name (mission, vision, values, team, achievements)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'About content section retrieved successfully' })
  async findBySection(@Param('section') section: string) {
    return this.aboutContentService.findBySection(section);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get about content by ID' })
  @ApiParam({ name: 'id', description: 'About content ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'About content retrieved successfully' })
  async findById(@Param('id') id: string) {
    return this.aboutContentService.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create new about content section' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'About content section created successfully' })
  async create(@Body() createAboutContentDto: CreateAboutContentDto) {
    return this.aboutContentService.create(createAboutContentDto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update about content section' })
  @ApiParam({ name: 'id', description: 'About content ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'About content section updated successfully' })
  async update(
    @Param('id') id: string,
    @Body() updateAboutContentDto: UpdateAboutContentDto
  ) {
    return this.aboutContentService.update(id, updateAboutContentDto);
  }

  @Put('order')
  @ApiOperation({ summary: 'Update about content sections order' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Order updated successfully' })
  async updateOrder(@Body() updateOrderDto: UpdateOrderDto) {
    return this.aboutContentService.updateOrder(updateOrderDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete about content section' })
  @ApiParam({ name: 'id', description: 'About content ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'About content section deleted successfully' })
  async remove(@Param('id') id: string) {
    return this.aboutContentService.remove(id);
  }
}
