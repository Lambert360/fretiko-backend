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
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
// import { Public } from '../auth/public.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto/product.dto';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get('categories')
  async getCategories() {
    console.log('📦 Fetching product categories');
    return this.productsService.getCategories();
  }

  @Get()
  async getProducts(@Query() query: ProductQueryDto) {
    console.log('📦 Fetching products with query:', query);
    return this.productsService.getProducts(query);
  }

  @Get('my-products')
  @UseGuards(JwtAuthGuard)
  async getMyProducts(@Request() req) {
    console.log('📦 Fetching my products for user:', req.user.sub);
    return this.productsService.getMyProducts(req.user.sub, req.supabaseToken);
  }

  // @Public()
  @Get('user/:userId')
  async getUserProducts(@Param('userId') userId: string) {
    console.log('📦 Fetching public products for user:', userId);
    return this.productsService.getMyProducts(userId);
  }

  @Get(':id')
  async getProduct(@Param('id') id: string) {
    console.log('📦 Fetching product:', id);
    return this.productsService.getProduct(id);
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
  @UseInterceptors(FilesInterceptor('images', 10)) // Allow up to 10 images
  async uploadProduct(
    @Request() req,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: any, // Use any for FormData parsing
  ) {
    console.log('📦 Uploading product with files for user:', req.user.sub);
    console.log('📝 Raw FormData body:', body);

    // Parse FormData fields manually
    const productData: CreateProductDto = {
      name: body.name,
      description: body.description,
      price: parseFloat(body.price),
      category_id: body.category_id,
      condition: body.condition,
      quantity: parseInt(body.quantity),
      location: body.location,
      images: [], // Will be populated by the service
      tags: body.tags ? JSON.parse(body.tags) : [],
      shipping_options: body.shipping_options ? JSON.parse(body.shipping_options) : undefined,
    };

    console.log('📦 Parsed product data:', productData);

    return await this.productsService.uploadProductWithFiles(
      req.user.sub,
      files,
      productData,
      req.supabaseToken,
    );
  }
}