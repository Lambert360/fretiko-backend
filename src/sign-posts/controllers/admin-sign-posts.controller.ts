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
  UseInterceptors,
  UploadedFile,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { StaffJwtAuthGuard } from '../../staff/guards/staff-jwt-auth.guard';
import { SignPostsService } from '../sign-posts.service';
import {
  CreateSignPostDto,
  UpdateSignPostDto,
  UpdateSignPostMediaDto,
  SignPostQueryDto,
} from '../dto/sign-post.dto';

@ApiTags('App Management - Sign Posts')
@Controller('admin/app-management/sign-posts')
@UseGuards(StaffJwtAuthGuard)
export class AdminSignPostsController {
  constructor(private readonly signPostsService: SignPostsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all sign posts' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Sign posts retrieved successfully' })
  async findAll(@Query() query: SignPostQueryDto) {
    return this.signPostsService.findAll(query.isActive);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get sign post by ID' })
  @ApiParam({ name: 'id', description: 'Sign post ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Sign post retrieved successfully' })
  async findById(@Param('id') id: string) {
    return this.signPostsService.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new sign post' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Sign post created successfully' })
  async create(@Body() createSignPostDto: CreateSignPostDto) {
    return this.signPostsService.create(createSignPostDto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a sign post' })
  @ApiParam({ name: 'id', description: 'Sign post ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Sign post updated successfully' })
  async update(
    @Param('id') id: string,
    @Body() updateSignPostDto: UpdateSignPostDto,
  ) {
    return this.signPostsService.update(id, updateSignPostDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a sign post' })
  @ApiParam({ name: 'id', description: 'Sign post ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Sign post deleted successfully' })
  async remove(@Param('id') id: string) {
    return this.signPostsService.remove(id);
  }

  @Post('upload')
  @ApiOperation({ summary: 'Upload a sign post media file and return its URL' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Media uploaded successfully' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
    }),
  )
  async uploadGenericMedia(@UploadedFile() file: Express.Multer.File) {
    return this.signPostsService.uploadGenericMedia(file, 'uploads');
  }

  @Post(':id/media')
  @ApiOperation({ summary: 'Upload media for a sign post' })
  @ApiParam({ name: 'id', description: 'Sign post ID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        sortOrder: { type: 'number' },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Media uploaded successfully' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
    }),
  )
  async addMedia(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('sortOrder') sortOrder?: string,
  ) {
    const sort = sortOrder ? parseInt(sortOrder, 10) : 0;
    return this.signPostsService.addMedia(id, file, sort);
  }

  @Put('media/:mediaId')
  @ApiOperation({ summary: 'Update sign post media (sort order, thumbnail)' })
  @ApiParam({ name: 'mediaId', description: 'Media item ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Media updated successfully' })
  async updateMedia(
    @Param('mediaId') mediaId: string,
    @Body() updateSignPostMediaDto: UpdateSignPostMediaDto,
  ) {
    return this.signPostsService.updateMedia(mediaId, updateSignPostMediaDto);
  }

  @Delete('media/:mediaId')
  @ApiOperation({ summary: 'Delete sign post media' })
  @ApiParam({ name: 'mediaId', description: 'Media item ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Media deleted successfully' })
  async removeMedia(@Param('mediaId') mediaId: string) {
    return this.signPostsService.removeMedia(mediaId);
  }
}
