import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { CreateProductDto, UpdateProductDto, ProductQueryDto, ProductResponseDto, ProductCategoryDto } from './dto/product.dto';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

@Injectable()
export class ProductsService {
  private supabase;
  private serviceSupabase;

  constructor(
    private configService: ConfigService,
    private supabaseClientManager: SupabaseClientManager,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
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
    // Verify user is a seller using serviceSupabase to bypass RLS
    const { data: userProfile } = await this.serviceSupabase
      .from('user_profiles')
      .select('is_seller')
      .eq('id', userId)
      .single();

    if (!userProfile?.is_seller) {
      throw new ForbiddenException('Only sellers can create products');
    }

    // Verify category exists using serviceSupabase
    console.log(' Validating category_id:', createProductDto.category_id);

    const { data: category, error: categoryError } = await this.serviceSupabase
      .from('product_categories')
      .select('id, name')
      .eq('id', createProductDto.category_id)
      .single();

    console.log(' Category query result:', { category, categoryError });

    if (categoryError) {
      console.error(' Category query error:', categoryError);
    }

    if (!category) {
      // Check what categories actually exist
      const { data: allCategories } = await this.serviceSupabase
        .from('product_categories')
        .select('id, name')
        .limit(10);
      console.log(' Available categories:', allCategories);

      throw new BadRequestException(`Invalid category: ${createProductDto.category_id}`);
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
      primary_image_url: createProductDto.primary_image_url || createProductDto.images?.[0] || null,
      videos: createProductDto.videos || [],
      primary_video_url: createProductDto.primary_video_url || null,
      media_type: createProductDto.media_type || 'image',
      location: createProductDto.location,
      shipping_options: createProductDto.shipping_options || { pickup: false, delivery: false, shipping: false },
      tags: createProductDto.tags || [],
      status: 'active',
    };

    // Use serviceSupabase for product insert - user tokens can't be used for DB operations
    const { data, error } = await this.serviceSupabase
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
      .select(`
        *,
        user_profiles!products_user_id_fkey (
          username,
          avatar_url,
          is_verified
        )
      `)
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

    console.log('🛍️ Raw products from DB:', data?.length || 0, 'products');
    if (data && data.length > 0) {
      console.log('🛍️ First 3 products review stats:');
      data.slice(0, 3).forEach((p, i) => {
        console.log(`  Product ${i + 1} (${p.name}):`, {
          id: p.id,
          average_rating: p.average_rating,
          review_count: p.review_count,
        });
      });
    }

    return (data || []).map(product => this.mapToProductResponse(product));
  }

  async getMyProducts(userId: string, userToken?: string): Promise<ProductResponseDto[]> {
    // Use serviceSupabase - user tokens can't be used for DB operations
    const { data, error } = await this.serviceSupabase
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
      const { data, error } = await this.serviceSupabase
        .from('products')
        .select(`
          *,
          user_profiles!products_user_id_fkey (
            username,
            avatar_url
          )
        `)
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
      await this.serviceSupabase
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
    // Verify product ownership using serviceSupabase
    const { data: product } = await this.serviceSupabase
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

    // Use serviceSupabase for update - user tokens can't be used for DB operations
    const { data, error } = await this.serviceSupabase
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
    const { data: product } = await this.serviceSupabase
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

    // Soft delete using serviceSupabase
    const { error } = await this.serviceSupabase
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

      // Join with user_profiles to get reviewer information
      const { data, error } = await this.serviceSupabase
        .from('product_ratings')
        .select(`
          *,
          user_profiles!product_ratings_user_id_fkey (
            id,
            username,
            avatar_url
          )
        `)
        .eq('product_id', productId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Supabase error fetching reviews:', error);
        console.error('Error details:', JSON.stringify(error, null, 2));
        throw new Error(`Failed to fetch product reviews: ${error.message}`);
      }

      console.log(`Found ${data?.length || 0} reviews`);

      // Map database fields to frontend format with user profile data
      return data?.map(review => ({
        id: review.id,
        userId: review.user_id,
        userName: review.user_profiles?.username || 'Anonymous',
        userAvatar: review.user_profiles?.avatar_url || null,
        rating: review.rating,
        comment: review.review || '',
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
    // Use serviceSupabase - user tokens can't be used for DB operations

    // Validate rating
    if (reviewData.rating < 1 || reviewData.rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    // Check if product exists
    const { data: product } = await this.serviceSupabase
      .from('products')
      .select('id')
      .eq('id', productId)
      .single();

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    // Check if user already reviewed this product
    const { data: existingReview } = await this.serviceSupabase
      .from('product_ratings')
      .select('id')
      .eq('product_id', productId)
      .eq('user_id', userId)
      .single();

    if (existingReview) {
      throw new BadRequestException('You have already reviewed this product');
    }

    // Add the review - product_ratings table has 'review' column, not 'comment'
    const { data, error } = await this.serviceSupabase
      .from('product_ratings')
      .insert({
        product_id: productId,
        user_id: userId,
        rating: reviewData.rating,
        review: reviewData.comment, // Column is named 'review' in the database
        helpful_count: 0,
      })
      .select(`
        *,
        user_profiles!product_ratings_user_id_fkey (
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
      comment: data.review || '', // Map 'review' column to 'comment' for frontend compatibility
      createdAt: data.created_at,
      helpful: data.helpful_count || 0,
    };
  }

  private async updateProductAverageRating(productId: string) {
    // Calculate new average rating
    const { data: reviews } = await this.supabase
      .from('product_ratings')
      .select('rating')
      .eq('product_id', productId);

    // Always update, even if there are no reviews (set to 0)
    const average = reviews && reviews.length > 0
      ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length
      : 0;
    const count = reviews ? reviews.length : 0;

    // Update product with new rating stats, handling NULL values by setting to 0
    await this.supabase
      .from('products')
      .update({
        average_rating: average,
        review_count: count
      })
      .eq('id', productId);

    console.log(`✅ Updated product ${productId} ratings: average=${average.toFixed(2)}, count=${count}`);
  }

  /**
   * Upload product with image files handling (using multer)
   */
  async uploadProductWithFiles(
    userId: string,
    imageFiles: Express.Multer.File[],
    videoFiles: Express.Multer.File[],
    productData: CreateProductDto,
    userToken?: string
  ): Promise<any> {
    try {
      if ((!imageFiles || imageFiles.length === 0) && (!videoFiles || videoFiles.length === 0)) {
        throw new BadRequestException('At least one image or video file is required');
      }

      // Use service role client for storage uploads - user tokens cannot be used
      // with Supabase Storage because they use a different JWT signing secret
      const supabaseClient = this.serviceSupabase;

      // Verify user is a seller using serviceSupabase to bypass RLS
      const { data: userProfile } = await this.serviceSupabase
        .from('user_profiles')
        .select('is_seller')
        .eq('id', userId)
        .single();

      if (!userProfile?.is_seller) {
        throw new ForbiddenException('Only sellers can create products');
      }

      let imageUrls: string[] = [];
      let videoUrls: string[] = [];

      // Validate and upload images
      if (imageFiles && imageFiles.length > 0) {
        const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        const maxImageSize = 10 * 1024 * 1024; // 10MB per image

        for (const file of imageFiles) {
          if (!allowedImageTypes.includes(file.mimetype)) {
            throw new BadRequestException('Invalid image file type. Only JPEG, PNG, and WebP are allowed.');
          }
          if (file.size > maxImageSize) {
            throw new BadRequestException('Image file too large. Maximum size is 10MB per image.');
          }
        }

        // Upload all images to Supabase Storage
        const imageUploadPromises = imageFiles.map(async (file, index) => {
          const fileExtension = file.originalname.split('.').pop() || 'jpg';
          const timestamp = Date.now();
          const uniqueFileName = `${userId}/${timestamp}-${index}-product-img.${fileExtension}`;

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

        imageUrls = await Promise.all(imageUploadPromises);
      }

      // Validate and upload videos
      if (videoFiles && videoFiles.length > 0) {
        const allowedVideoTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
        const maxVideoSize = 50 * 1024 * 1024; // 50MB per video

        for (const file of videoFiles) {
          if (!allowedVideoTypes.includes(file.mimetype)) {
            throw new BadRequestException('Invalid video file type. Only MP4, MOV, and AVI are allowed.');
          }
          if (file.size > maxVideoSize) {
            throw new BadRequestException('Video file too large. Maximum size is 50MB per video.');
          }
        }

        // Upload all videos to Supabase Storage
        const videoUploadPromises = videoFiles.map(async (file, index) => {
          const fileExtension = file.originalname.split('.').pop() || 'mp4';
          const timestamp = Date.now();
          const uniqueFileName = `${userId}/${timestamp}-${index}-product-vid.${fileExtension}`;

          const { data: uploadData, error: uploadError } = await supabaseClient.storage
            .from('media')
            .upload(uniqueFileName, file.buffer, {
              contentType: file.mimetype,
              upsert: false,
            });

          if (uploadError) {
            throw new BadRequestException(`Video upload failed: ${uploadError.message}`);
          }

          // Get public URL
          const { data: urlData } = supabaseClient.storage
            .from('media')
            .getPublicUrl(uniqueFileName);

          return urlData.publicUrl;
        });

        videoUrls = await Promise.all(videoUploadPromises);

        // Generate thumbnail for the first video if no images were provided
        if (imageUrls.length === 0 && videoFiles.length > 0) {
          console.log('📸 No images provided, generating thumbnail from video...');
          try {
            const thumbnailUrl = await this.generateVideoThumbnail(videoFiles[0], userId, supabaseClient);
            if (thumbnailUrl) {
              imageUrls = [thumbnailUrl];
              console.log('✅ Thumbnail generated successfully:', thumbnailUrl);
            }
          } catch (error) {
            console.error('⚠️ Failed to generate video thumbnail:', error);
            // Continue without thumbnail - product will use placeholder
          }
        }
      }

      // Determine media type (video takes precedence for product display)
      const media_type = videoUrls.length > 0 ? 'video' : 'image';

      // Create product with uploaded media URLs
      const createProductDto: CreateProductDto = {
        ...productData,
        images: imageUrls,
        primary_image_url: imageUrls.length > 0 ? imageUrls[0] : undefined,
        videos: videoUrls,
        primary_video_url: videoUrls.length > 0 ? videoUrls[0] : undefined,
        media_type,
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

  /**
   * Generate a thumbnail from a video file using ffmpeg
   */
  private async generateVideoThumbnail(
    videoFile: Express.Multer.File,
    userId: string,
    supabaseClient: any
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      // Create temporary paths
      const tempDir = os.tmpdir();
      const videoPath = path.join(tempDir, `video-${Date.now()}.mp4`);
      const thumbnailPath = path.join(tempDir, `thumbnail-${Date.now()}.jpg`);

      try {
        // Write video buffer to temporary file
        fs.writeFileSync(videoPath, videoFile.buffer);

        // Extract thumbnail at 1 second mark
        ffmpeg(videoPath)
          .screenshots({
            timestamps: ['00:00:01.000'],
            filename: path.basename(thumbnailPath),
            folder: path.dirname(thumbnailPath),
            size: '640x?', // Maintain aspect ratio
          })
          .on('end', async () => {
            try {
              // Read the generated thumbnail
              const thumbnailBuffer = fs.readFileSync(thumbnailPath);

              // Upload thumbnail to Supabase Storage
              const timestamp = Date.now();
              const uniqueFileName = `${userId}/${timestamp}-video-thumbnail.jpg`;

              const { error: uploadError } = await supabaseClient.storage
                .from('media')
                .upload(uniqueFileName, thumbnailBuffer, {
                  contentType: 'image/jpeg',
                  upsert: false,
                });

              if (uploadError) {
                console.error('Thumbnail upload error:', uploadError);
                resolve(null);
              } else {
                // Get public URL
                const { data: urlData } = supabaseClient.storage
                  .from('media')
                  .getPublicUrl(uniqueFileName);

                resolve(urlData.publicUrl);
              }

              // Clean up temporary files
              fs.unlinkSync(videoPath);
              fs.unlinkSync(thumbnailPath);
            } catch (error) {
              console.error('Error processing thumbnail:', error);
              // Clean up on error
              if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
              if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);
              resolve(null);
            }
          })
          .on('error', (error) => {
            console.error('FFmpeg error:', error);
            // Clean up on error
            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
            resolve(null);
          });
      } catch (error) {
        console.error('Error writing video file:', error);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        resolve(null);
      }
    });
  }

  private mapToProductResponse(data: any): ProductResponseDto {
    console.log('🗺️ Mapping product response:', {
      id: data.id,
      name: data.name,
      price: data.price,
      user_id: data.user_id,
      average_rating: data.average_rating,
      review_count: data.review_count,
      has_user_profiles: !!data.user_profiles,
      username: data.user_profiles?.username,
      avatar_url: data.user_profiles?.avatar_url,
      is_verified: data.user_profiles?.is_verified,
    });

    const mapped = {
      id: data.id,
      user_id: data.user_id,
      category_id: data.category_id,
      name: data.name,
      description: data.description,
      price: parseFloat(data.price) || 0,
      quantity: data.quantity,
      condition: data.condition,
      images: data.images || [],
      primary_image_url: data.primary_image_url,
      videos: data.videos || [],
      primary_video_url: data.primary_video_url,
      media_type: data.media_type || 'image',
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
      // Vendor info from joined user_profiles table
      vendor_username: data.user_profiles?.username || 'Unknown Seller',
      vendor_avatar: data.user_profiles?.avatar_url || null,
      vendor_verified: data.user_profiles?.is_verified || false,
    };

    console.log('✅ Mapped product:', {
      id: mapped.id,
      name: mapped.name,
      price: mapped.price,
      average_rating: mapped.average_rating,
      review_count: mapped.review_count,
      vendor_username: mapped.vendor_username,
      vendor_verified: mapped.vendor_verified,
    });

    return mapped;
  }
}