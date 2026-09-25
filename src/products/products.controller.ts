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
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor, FileFieldsInterceptor } from '@nestjs/platform-express';
// import { Public } from '../auth/public.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto, RankedProductsQueryDto, RecordProductEventDto } from './dto/product.dto';

// Postgres NUMERIC accepts NaN (and NaN >= 0 passes CHECK constraints), so
// reject non-finite parses at the boundary instead of storing NaN.
const parseOptionalFinite = (v: any): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

// FormData fields arrive as JSON strings; malformed input becomes a clean
// 400 instead of an unhandled SyntaxError 500.
const parseJsonField = <T = any>(v: any, field: string, fallback?: T): T | undefined => {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string') return v; // already an object (JSON-body clients)
  try {
    return JSON.parse(v);
  } catch {
    throw new BadRequestException(`Invalid JSON in '${field}'`);
  }
};

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get('categories')
  async getCategories() {
    console.log('📦 Fetching product categories');
    return this.productsService.getCategories();
  }

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  async getProducts(@Query() query: ProductQueryDto, @Request() req) {
    console.log('📦 Fetching products with query:', query);
    return this.productsService.getProducts(query, req.user?.sub || null);
  }

  @Get('trending')
  @UseGuards(OptionalJwtAuthGuard)
  async getTrendingProducts(@Query('limit') limit?: string, @Request() req?) {
    const parsedLimit = limit ? parseInt(limit, 10) : 10;
    console.log('📦 Fetching trending products, limit:', parsedLimit);
    return this.productsService.getTrendingProducts(Number.isNaN(parsedLimit) ? 10 : parsedLimit, req?.user?.sub || null);
  }

  @Get('seasonal')
  @UseGuards(OptionalJwtAuthGuard)
  async getSeasonalProducts(@Query('limit') limit?: string, @Query('region') region?: string, @Request() req?) {
    const parsedLimit = limit ? parseInt(limit, 10) : 12;
    console.log('📦 Fetching seasonal products, limit:', parsedLimit, 'region:', region);
    return this.productsService.getSeasonalProducts(Number.isNaN(parsedLimit) ? 12 : parsedLimit, region, req?.user?.sub || null);
  }

  // Location-aware, engagement/trust-ranked product feed for the HomeScreen product tab.
  // Works for both authenticated and guest users (personalization is applied when logged in).
  @Get('ranked')
  @UseGuards(OptionalJwtAuthGuard)
  async getRankedProducts(@Query() query: RankedProductsQueryDto, @Request() req) {
    const userId = req.user?.sub || null;
    console.log('📦 Fetching ranked products for user:', userId, 'query:', query);
    return this.productsService.getRankedProducts(userId, query);
  }

  // Record a product engagement event (impression, click, cart_add, etc.) for ranking feedback.
  @Post('events')
  @UseGuards(OptionalJwtAuthGuard)
  async recordProductEvent(@Body() dto: RecordProductEventDto, @Request() req) {
    const userId = req.user?.sub || null;
    return this.productsService.recordProductEvent(userId, dto);
  }

  @Get('my-products')
  @UseGuards(JwtAuthGuard)
  async getMyProducts(@Request() req) {
    console.log('📦 Fetching my products for user:', req.user.sub);
    return this.productsService.getMyProducts(req.user.sub, req.supabaseToken);
  }

  // @Public()
  @Get('user/:userId')
  @UseGuards(OptionalJwtAuthGuard)
  async getUserProducts(
    @Param('userId') userId: string,
    @Request() req,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    console.log('📦 Fetching public products for user:', userId);
    return this.productsService.getPublicProductsByUser(
      userId,
      req.user?.sub || null,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  async getProduct(@Param('id') id: string, @Request() req) {
    console.log('📦 Fetching product:', id);
    return this.productsService.getProduct(id, req.user?.sub || null);
  }

  // Public endpoint: Get product preview for deep linking (no auth required)
  @Get('public/:id')
  @UseGuards(OptionalJwtAuthGuard)
  async getPublicProduct(@Param('id') id: string, @Request() req) {
    console.log('📦 Fetching public product:', id);
    return this.productsService.getProduct(id, req.user?.sub || null);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async createProduct(@Request() req, @Body() createProductDto: CreateProductDto) {
    console.log('📦 Creating product for user:', req.user.sub);
    console.log('📦 Product data:', createProductDto);
    
    try {
      return await this.productsService.createProduct(req.user.sub, createProductDto, req.supabaseToken);
    } catch (error) {
      console.error('❌ Product creation failed:', error);
      throw error;
    }
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  async updateProduct(
    @Param('id') id: string,
    @Request() req,
    @Body() updateProductDto: UpdateProductDto,
  ) {
    console.log('📦 Updating product:', id, 'for user:', req.user.sub);
    
    try {
      return await this.productsService.updateProduct(id, req.user.sub, updateProductDto, req.supabaseToken);
    } catch (error) {
      console.error('❌ Product update failed:', error);
      throw error;
    }
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async deleteProduct(@Param('id') id: string, @Request() req) {
    console.log('📦 Deleting product:', id, 'for user:', req.user.sub);
    
    try {
      await this.productsService.deleteProduct(id, req.user.sub, req.supabaseToken);
      return { message: 'Product deleted successfully' };
    } catch (error) {
      console.error('❌ Product deletion failed:', error);
      throw error;
    }
  }

  @Get(':id/reviews')
  async getProductReviews(@Param('id') id: string) {
    console.log('📦 Fetching reviews for product:', id);
    return this.productsService.getProductReviews(id);
  }

  @Get(':id/review-eligibility')
  @UseGuards(JwtAuthGuard)
  async getReviewEligibility(@Param('id') productId: string, @Request() req) {
    return this.productsService.getReviewEligibility(productId, req.user.sub);
  }

  @Post(':id/reviews')
  @UseGuards(JwtAuthGuard)
  async addProductReview(
    @Param('id') productId: string,
    @Request() req,
    @Body() reviewData: { rating: number; comment: string }
  ) {
    console.log('📦 Adding review for product:', productId, 'by user:', req.user.sub);
    return this.productsService.addProductReview(productId, req.user.sub, reviewData, req.supabaseToken);
  }

  @Post('upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'images', maxCount: 10 },
      { name: 'videos', maxCount: 2 },
      { name: 'variant_media', maxCount: 20 },
    ]),
  )
  async uploadProduct(
    @Request() req,
    @UploadedFiles() files: { images?: Express.Multer.File[]; videos?: Express.Multer.File[]; variant_media?: Express.Multer.File[] },
    @Body() body: any, // Use any for FormData parsing
  ) {
    console.log('📦 Uploading product with files for user:', req.user.sub);
    console.log('📝 Raw FormData body:', body);
    console.log('📸 Images count:', files?.images?.length || 0);
    console.log('🎥 Videos count:', files?.videos?.length || 0);
    console.log('🧩 Variant media count:', files?.variant_media?.length || 0);

    // Parse FormData fields manually
    const productData: CreateProductDto = {
      name: body.name,
      description: body.description,
      price: parseFloat(body.price),
      category_id: body.category_id,
      condition: body.condition,
      quantity: parseInt(body.quantity),
      weight_kg: parseOptionalFinite(body.weight_kg),
      length_cm: parseOptionalFinite(body.length_cm),
      width_cm: parseOptionalFinite(body.width_cm),
      height_cm: parseOptionalFinite(body.height_cm),
      location: body.location,
      location_latitude: parseOptionalFinite(body.location_latitude),
      location_longitude: parseOptionalFinite(body.location_longitude),
      images: [], // Will be populated by the service
      videos: [], // Will be populated by the service
      tags: parseJsonField(body.tags, 'tags', []),
      shipping_options: parseJsonField(body.shipping_options, 'shipping_options'),
      is_multi_item: body.is_multi_item === 'true' || body.is_multi_item === true,
      variants: parseJsonField(body.variants, 'variants'),
    };

    console.log('📦 Parsed product data:', productData);

    return await this.productsService.uploadProductWithFiles(
      req.user.sub,
      files?.images || [],
      files?.videos || [],
      productData,
      req.supabaseToken,
      files?.variant_media || [],
    );
  }
}