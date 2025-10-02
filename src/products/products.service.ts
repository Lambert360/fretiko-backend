import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { CreateProductDto, UpdateProductDto, ProductQueryDto, ProductResponseDto, ProductCategoryDto } from './dto/product.dto';

@Injectable()
export class ProductsService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async getCategories(): Promise<ProductCategoryDto[]> {
    const { data, error } = await this.supabase
      .from('product_categories')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) {
      throw new Error(`Database error: ${error.message}`);
    }

    return data || [];
  }

  async createProduct(userId: string, createProductDto: CreateProductDto, userToken?: string): Promise<ProductResponseDto> {
    // Use user-authenticated client if available
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Verify user is a seller
    const { data: userProfile } = await client
      .from('user_profiles')
      .select('is_seller')
      .eq('id', userId)
      .single();

    if (!userProfile?.is_seller) {
      throw new ForbiddenException('Only sellers can create products');
    }

    // Verify category exists
    const { data: category } = await client
      .from('product_categories')
      .select('id')
      .eq('id', createProductDto.category_id)
      .single();

    if (!category) {
      throw new BadRequestException('Invalid category');
    }

    // Prepare product data
    const productData = {
      user_id: userId,
      category_id: createProductDto.category_id,
      name: createProductDto.name,
      description: createProductDto.description,
      price: createProductDto.price,
      quantity: createProductDto.quantity,
      condition: createProductDto.condition,
      images: createProductDto.images || [],
      primary_image_url: createProductDto.images?.[0] || null,
      location: createProductDto.location,
      shipping_options: createProductDto.shipping_options || { pickup: false, delivery: false, shipping: false },
      tags: createProductDto.tags || [],
      status: 'active',
    };

    const { data, error } = await client
      .from('products')
      .insert([productData])
      .select()
      .single();

    if (error) {
      console.error('Product creation error:', error);
      throw new Error(`Failed to create product: ${error.message}`);
    }

    return this.mapToProductResponse(data);
  }

  async getProducts(query: ProductQueryDto): Promise<ProductResponseDto[]> {
    let queryBuilder = this.supabase
      .from('products')
      .select('*')
      .eq('status', 'active')
      .is('deleted_at', null);

    if (query.category_id) {
      queryBuilder = queryBuilder.eq('category_id', query.category_id);
    }

    if (query.search) {
      queryBuilder = queryBuilder.textSearch('search_vector', query.search);
    }

    const { data, error } = await queryBuilder
      .order('created_at', { ascending: false })
      .range(query.offset || 0, (query.offset || 0) + (query.limit || 20) - 1);

    if (error) {
      throw new Error(`Database error: ${error.message}`);
    }

    return (data || []).map(this.mapToProductResponse);
  }

  async getMyProducts(userId: string, userToken?: string): Promise<ProductResponseDto[]> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('products')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Database error: ${error.message}`);
    }

    return (data || []).map(this.mapToProductResponse);
  }

  async getProduct(id: string): Promise<ProductResponseDto> {
    try {
      const { data, error } = await this.supabase
        .from('products')
        .select('*')
        .eq('id', id)
        .eq('status', 'active')
        .is('deleted_at', null)
        .single();

      if (error) {
        console.error('Supabase error fetching product:', error);
        if (error.code === 'PGRST116') {
          throw new NotFoundException('Product not found');
        }
        throw new Error(`Database error: ${error.message}`);
      }

      if (!data) {
        throw new NotFoundException('Product not found');
      }

      // Increment view count with null safety
      const currentViewCount = data.view_count || 0;
      await this.supabase
        .from('products')
        .update({ view_count: currentViewCount + 1 })
        .eq('id', id);

      return this.mapToProductResponse(data);
    } catch (error) {
      console.error('Error in getProduct:', error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new Error(`Failed to fetch product: ${error.message}`);
    }
  }

  async updateProduct(id: string, userId: string, updateProductDto: UpdateProductDto, userToken?: string): Promise<ProductResponseDto> {
    // Verify product ownership
    const { data: product } = await this.supabase
      .from('products')
      .select('user_id')
      .eq('id', id)
      .single();

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.user_id !== userId) {
      throw new ForbiddenException('You can only update your own products');
    }

    // Prepare update data
    const updateData: any = {};
    if (updateProductDto.name !== undefined) updateData.name = updateProductDto.name;
    if (updateProductDto.description !== undefined) updateData.description = updateProductDto.description;
    if (updateProductDto.price !== undefined) updateData.price = updateProductDto.price;
    if (updateProductDto.quantity !== undefined) updateData.quantity = updateProductDto.quantity;
    if (updateProductDto.condition !== undefined) updateData.condition = updateProductDto.condition;
    if (updateProductDto.category_id !== undefined) updateData.category_id = updateProductDto.category_id;
    if (updateProductDto.images !== undefined) {
      updateData.images = updateProductDto.images;
      updateData.primary_image_url = updateProductDto.images[0] || null;
    }
    if (updateProductDto.location !== undefined) updateData.location = updateProductDto.location;
    if (updateProductDto.shipping_options !== undefined) updateData.shipping_options = updateProductDto.shipping_options;
    if (updateProductDto.tags !== undefined) updateData.tags = updateProductDto.tags;
    if (updateProductDto.status !== undefined) updateData.status = updateProductDto.status;

    // Use user-authenticated client if available
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('products')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update product: ${error.message}`);
    }

    return this.mapToProductResponse(data);
  }

  async deleteProduct(id: string, userId: string, userToken?: string): Promise<void> {
    // Verify product ownership
    const { data: product } = await this.supabase
      .from('products')
      .select('user_id')
      .eq('id', id)
      .single();

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.user_id !== userId) {
      throw new ForbiddenException('You can only delete your own products');
    }

    // Soft delete
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { error } = await client
      .from('products')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete product: ${error.message}`);
    }
  }

  async getProductReviews(productId: string) {
    try {
      console.log(`Fetching reviews for product: ${productId}`);

      // First try without the join to isolate the issue
      const { data, error } = await this.supabase
        .from('product_reviews')
        .select('*')
        .eq('product_id', productId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Supabase error fetching reviews:', error);
        console.error('Error details:', JSON.stringify(error, null, 2));
        throw new Error(`Failed to fetch product reviews: ${error.message}`);
      }

      console.log(`Found ${data?.length || 0} reviews`);

      // For now, return simplified data without user profiles
      // TODO: Add user profile join back once we fix the relationship
      return data?.map(review => ({
        id: review.id,
        userId: review.user_id,
        userName: 'Anonymous', // Temporary fallback
        userAvatar: null,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.created_at,
        helpful: review.helpful_count || 0,
      })) || [];
    } catch (error) {
      console.error('Error in getProductReviews:', error);
      console.error('Full error object:', error);
      // Return empty array instead of throwing to prevent crash
      return [];
    }
  }

  async addProductReview(productId: string, userId: string, reviewData: { rating: number; comment: string }, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Validate rating
    if (reviewData.rating < 1 || reviewData.rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    // Check if product exists
    const { data: product } = await client
      .from('products')
      .select('id')
      .eq('id', productId)
      .single();

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    // Check if user already reviewed this product
    const { data: existingReview } = await client
      .from('product_reviews')
      .select('id')
      .eq('product_id', productId)
      .eq('user_id', userId)
      .single();

    if (existingReview) {
      throw new BadRequestException('You have already reviewed this product');
    }

    // Add the review
    const { data, error } = await client
      .from('product_reviews')
      .insert({
        product_id: productId,
        user_id: userId,
        rating: reviewData.rating,
        comment: reviewData.comment,
        helpful_count: 0,
      })
      .select(`
        *,
        user_profiles!product_reviews_user_id_fkey (
          username,
          avatar_url
        )
      `)
      .single();

    if (error) {
      throw new Error(`Failed to add product review: ${error.message}`);
    }

    // Update product's average rating
    await this.updateProductAverageRating(productId);

    return {
      id: data.id,
      userId: data.user_id,
      userName: data.user_profiles?.username || 'Anonymous',
      userAvatar: data.user_profiles?.avatar_url || null,
      rating: data.rating,
      comment: data.comment,
      createdAt: data.created_at,
      helpful: data.helpful_count || 0,
    };
  }

  private async updateProductAverageRating(productId: string) {
    // Calculate new average rating
    const { data: reviews } = await this.supabase
      .from('product_reviews')
      .select('rating')
      .eq('product_id', productId);

    if (reviews && reviews.length > 0) {
      const average = reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length;
      
      await this.supabase
        .from('products')
        .update({ 
          average_rating: average,
          review_count: reviews.length 
        })
        .eq('id', productId);
    }
  }

  /**
   * Upload product with image files handling (using multer)
   */
  async uploadProductWithFiles(
    userId: string,
    files: Express.Multer.File[],
    productData: CreateProductDto,
    userToken?: string
  ): Promise<any> {
    try {
      if (!files || files.length === 0) {
        throw new BadRequestException('At least one image file is required');
      }

      // Validate files
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
      const maxSize = 10 * 1024 * 1024; // 10MB per image

      for (const file of files) {
        if (!allowedTypes.includes(file.mimetype)) {
          throw new BadRequestException('Invalid file type. Only JPEG, PNG, and WebP images are allowed.');
        }
        if (file.size > maxSize) {
          throw new BadRequestException('Image file too large. Maximum size is 10MB per image.');
        }
      }

      const supabaseClient = userToken
        ? createUserSupabaseClient(this.configService, userToken)
        : this.supabase;

      // Verify user is a seller
      const { data: userProfile } = await supabaseClient
        .from('user_profiles')
        .select('is_seller')
        .eq('id', userId)
        .single();

      if (!userProfile?.is_seller) {
        throw new ForbiddenException('Only sellers can create products');
      }

      // Upload all images to Supabase Storage
      const uploadPromises = files.map(async (file, index) => {
        const fileExtension = file.originalname.split('.').pop() || 'jpg';
        const timestamp = Date.now();
        const uniqueFileName = `${userId}/${timestamp}-${index}-product.${fileExtension}`;

        const { data: uploadData, error: uploadError } = await supabaseClient.storage
          .from('media')
          .upload(uniqueFileName, file.buffer, {
            contentType: file.mimetype,
            upsert: false,
          });

        if (uploadError) {
          throw new BadRequestException(`Image upload failed: ${uploadError.message}`);
        }

        // Get public URL
        const { data: urlData } = supabaseClient.storage
          .from('media')
          .getPublicUrl(uniqueFileName);

        return urlData.publicUrl;
      });

      const imageUrls = await Promise.all(uploadPromises);

      // Create product with uploaded image URLs
      const createProductDto: CreateProductDto = {
        ...productData,
        images: imageUrls,
        primary_image_url: imageUrls[0], // First image as primary
      };

      // Create product record
      const product = await this.createProduct(userId, createProductDto, userToken);

      return {
        ...product,
        message: 'Product uploaded successfully',
      };

    } catch (error) {
      console.error('Product upload error:', error);
      throw error;
    }
  }

  private mapToProductResponse(data: any): ProductResponseDto {
    return {
      id: data.id,
      user_id: data.user_id,
      category_id: data.category_id,
      name: data.name,
      description: data.description,
      price: parseFloat(data.price),
      quantity: data.quantity,
      condition: data.condition,
      images: data.images || [],
      primary_image_url: data.primary_image_url,
      location: data.location,
      shipping_options: data.shipping_options,
      tags: data.tags || [],
      status: data.status,
      is_featured: data.is_featured,
      view_count: data.view_count,
      like_count: data.like_count,
      save_count: data.save_count,
      average_rating: data.average_rating,
      review_count: data.review_count || 0,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  }
}