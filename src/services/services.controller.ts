import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
  Query,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { ServicesService } from './services.service';
import { CreateServiceDto, UpdateServiceDto } from './dto/service.dto';

@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get('categories')
  async getCategories() {
    return this.servicesService.getCategories();
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async createService(@Request() req, @Body() createServiceDto: CreateServiceDto) {
    console.log('🚚 Creating service for user:', req.user.sub);
    console.log('📦 Service data:', createServiceDto);
    return this.servicesService.createService(req.user.sub, createServiceDto, req.supabaseToken);
  }

  @Get('my-services')
  @UseGuards(JwtAuthGuard)
  async getMyServices(@Request() req) {
    return this.servicesService.getServicesByUser(req.user.sub, req.supabaseToken);
  }

  @Get('video-feed')
  @UseGuards(OptionalJwtAuthGuard)
  async getVideoFeed(
    @Request() req,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    // Try to get userId from request if user is authenticated (optional)
    const userId = req.user?.sub || null;

    console.log('🎥 Controller getVideoFeed called with userId:', userId, 'limit:', limit, 'offset:', offset);
    const queryOptions = {
      limit: limit ? parseInt(limit, 10) : 10,
      offset: offset ? parseInt(offset, 10) : 0,
    };
    console.log('🎥 Controller calling service with options:', queryOptions);
    const result = await this.servicesService.getVideoFeed(userId, queryOptions);
    console.log('🎥 Controller returning result with', result.length, 'items');
    return result;
  }

  @Get('user/:userId')
  async getUserServices(@Param('userId') userId: string) {
    console.log('🚚 Fetching services for user:', userId);
    return this.servicesService.getServicesByUser(userId);
  }

  @Get()
  async getServices(
    @Query('category_id') categoryId?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const queryOptions = {
      category_id: categoryId,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    };
    return this.servicesService.getServices(queryOptions);
  }

  @Get(':id')
  async getService(@Param('id') id: string) {
    return this.servicesService.getService(id);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  async updateService(
    @Request() req,
    @Param('id') id: string,
    @Body() updateServiceDto: UpdateServiceDto,
  ) {
    return this.servicesService.updateService(req.user.sub, id, updateServiceDto, req.supabaseToken);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async deleteService(@Request() req, @Param('id') id: string) {
    return this.servicesService.deleteService(req.user.sub, id, req.supabaseToken);
  }

  @Get(':id/likes')
  @UseGuards(JwtAuthGuard)
  async getServiceLikers(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const likers = await this.servicesService.getServiceLikers(
      id,
      limit ? parseInt(limit) : 50,
      offset ? parseInt(offset) : 0,
    );
    return { success: true, data: likers };
  }

  @Post(':id/like')
  @UseGuards(JwtAuthGuard)
  async toggleLike(@Request() req, @Param('id') id: string) {
    return this.servicesService.toggleLike(req.user.sub, id, req.supabaseToken);
  }

  @Post(':id/bookmark')
  @UseGuards(JwtAuthGuard)
  async toggleBookmark(@Request() req, @Param('id') id: string) {
    return this.servicesService.toggleBookmark(req.user.sub, id, req.supabaseToken);
  }

  @Get('user/bookmarks/me')
  @UseGuards(JwtAuthGuard)
  async getMyBookmarkedServices(@Request() req) {
    return this.servicesService.getBookmarkedServices(req.user.sub, req.supabaseToken);
  }

  @Post(':id/share')
  @UseGuards(JwtAuthGuard)
  async shareService(@Request() req, @Param('id') id: string) {
    return this.servicesService.incrementShareCount(id, req.supabaseToken);
  }

  @Get(':id/comments')
  async getComments(@Request() req, @Param('id') id: string) {
    return this.servicesService.getServiceComments(id, req.supabaseToken);
  }

  @Post(':id/comments')
  @UseGuards(JwtAuthGuard)
  async addComment(@Request() req, @Param('id') id: string, @Body() body: { content: string }) {
    return this.servicesService.addComment(req.user.sub, id, body.content, req.supabaseToken);
  }

  @Post(':id/rating')
  @UseGuards(JwtAuthGuard)
  async addRating(@Request() req, @Param('id') id: string, @Body() body: { rating: number }) {
    return this.servicesService.addRating(req.user.sub, id, body.rating, req.supabaseToken);
  }

  @Post('upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('media', 5)) // Allow up to 5 media files (images/videos)
  async uploadService(
    @Request() req,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: any, // Use any for FormData parsing
  ) {
    console.log('🚚 Uploading service with files for user:', req.user.sub);
    console.log('📝 Raw FormData body:', body);

    // Parse FormData fields manually
    const serviceData: CreateServiceDto = {
      name: body.name,
      description: body.description,
      base_price: parseFloat(body.base_price),
      category_id: body.category_id,
      duration: body.duration,
      location: body.location,
      service_area: body.service_area,
      availability: body.availability ? JSON.parse(body.availability) : { weekdays: false, weekends: false, evenings: false, emergency: false },
      tags: body.tags ? JSON.parse(body.tags) : [],
      booking_type: body.booking_type,
      images: [], // Will be populated by the service
      videos: [], // Will be populated by the service
    };

    console.log('🚚 Parsed service data:', serviceData);

    return await this.servicesService.uploadServiceWithFiles(
      req.user.sub,
      files,
      serviceData,
      req.supabaseToken,
    );
  }
}