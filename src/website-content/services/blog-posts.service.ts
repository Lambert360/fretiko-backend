import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../../shared/supabase.client';
import { CreateBlogPostDto, UpdateBlogPostDto, BlogPostQueryDto, BlogPostStatus } from '../dto/blog-post.dto';

@Injectable()
export class BlogPostsService {
  private serviceSupabase;

  constructor(private configService: ConfigService) {
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  async findAll(query: BlogPostQueryDto) {
    const { status, author, tags, search, page = 1, limit = 10 } = query;
    
    let queryBuilder = this.serviceSupabase
      .from('blog_posts')
      .select('*', { count: 'exact' });

    // Apply filters
    if (status) {
      queryBuilder = queryBuilder.eq('status', status);
    }

    if (author) {
      queryBuilder = queryBuilder.eq('author', author);
    }

    if (tags && tags.length > 0) {
      queryBuilder = queryBuilder.contains('tags', tags);
    }

    if (search) {
      queryBuilder = queryBuilder.or(`title.ilike.%${search}%,excerpt.ilike.%${search}%,content.ilike.%${search}%`);
    }

    // Apply pagination
    const offset = (page - 1) * limit;
    queryBuilder = queryBuilder
      .order('published_at', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await queryBuilder;

    if (error) {
      throw new Error(`Failed to fetch blog posts: ${error.message}`);
    }

    return {
      data: data || [],
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    };
  }

  async findPublished(query: BlogPostQueryDto) {
    const { author, tags, search, page = 1, limit = 10 } = query;
    
    let queryBuilder = this.serviceSupabase
      .from('blog_posts')
      .select('*', { count: 'exact' })
      .eq('status', BlogPostStatus.PUBLISHED);

    // Apply filters
    if (author) {
      queryBuilder = queryBuilder.eq('author', author);
    }

    if (tags && tags.length > 0) {
      queryBuilder = queryBuilder.contains('tags', tags);
    }

    if (search) {
      queryBuilder = queryBuilder.or(`title.ilike.%${search}%,excerpt.ilike.%${search}%,content.ilike.%${search}%`);
    }

    // Apply pagination
    const offset = (page - 1) * limit;
    queryBuilder = queryBuilder
      .order('published_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await queryBuilder;

    if (error) {
      throw new Error(`Failed to fetch published blog posts: ${error.message}`);
    }

    return {
      data: data || [],
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    };
  }

  async findOne(id: string) {
    const { data, error } = await this.serviceSupabase
      .from('blog_posts')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Blog post with ID ${id} not found`);
    }

    return data;
  }

  async findBySlug(slug: string) {
    const { data, error } = await this.serviceSupabase
      .from('blog_posts')
      .select('*')
      .eq('slug', slug)
      .eq('status', BlogPostStatus.PUBLISHED)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Blog post with slug '${slug}' not found`);
    }

    return data;
  }

  async create(createBlogPostDto: CreateBlogPostDto) {
    // Check if slug already exists
    const { data: existingSlug } = await this.serviceSupabase
      .from('blog_posts')
      .select('id')
      .eq('slug', createBlogPostDto.slug)
      .single();

    if (existingSlug) {
      throw new ConflictException(`Blog post with slug '${createBlogPostDto.slug}' already exists`);
    }

    const { data, error } = await this.serviceSupabase
      .from('blog_posts')
      .insert({
        ...createBlogPostDto,
        status: createBlogPostDto.status || BlogPostStatus.DRAFT,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        published_at: createBlogPostDto.status === BlogPostStatus.PUBLISHED ? new Date().toISOString() : null,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create blog post: ${error.message}`);
    }

    return data;
  }

  async update(id: string, updateBlogPostDto: UpdateBlogPostDto) {
    // Check if blog post exists
    await this.findOne(id);

    // If updating slug, check for duplicates
    if (updateBlogPostDto.slug) {
      const { data: existingSlug } = await this.serviceSupabase
        .from('blog_posts')
        .select('id')
        .eq('slug', updateBlogPostDto.slug)
        .neq('id', id)
        .single();

      if (existingSlug) {
        throw new ConflictException(`Blog post with slug '${updateBlogPostDto.slug}' already exists`);
      }
    }

    const updateData: any = {
      ...updateBlogPostDto,
      updated_at: new Date().toISOString(),
    };

    // If status is being updated to published, set published_at
    if (updateBlogPostDto.status === BlogPostStatus.PUBLISHED) {
      updateData.published_at = new Date().toISOString();
    }

    const { data, error } = await this.serviceSupabase
      .from('blog_posts')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update blog post: ${error.message}`);
    }

    return data;
  }

  async remove(id: string) {
    await this.findOne(id);

    const { error } = await this.serviceSupabase
      .from('blog_posts')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete blog post: ${error.message}`);
    }
  }

  async updateStatus(id: string, status: BlogPostStatus) {
    return this.update(id, { status });
  }

  async getStatistics() {
    const [
      { count: totalPosts },
      { count: publishedPosts },
      { count: draftPosts },
      { count: archivedPosts },
    ] = await Promise.all([
      this.serviceSupabase.from('blog_posts').select('*', { count: 'exact', head: true }),
      this.serviceSupabase.from('blog_posts').select('*', { count: 'exact', head: true }).eq('status', BlogPostStatus.PUBLISHED),
      this.serviceSupabase.from('blog_posts').select('*', { count: 'exact', head: true }).eq('status', BlogPostStatus.DRAFT),
      this.serviceSupabase.from('blog_posts').select('*', { count: 'exact', head: true }).eq('status', BlogPostStatus.ARCHIVED),
    ]);

    return {
      total: totalPosts || 0,
      published: publishedPosts || 0,
      draft: draftPosts || 0,
      archived: archivedPosts || 0,
    };
  }

  async getPostsByAuthor() {
    const { data, error } = await this.serviceSupabase
      .from('blog_posts')
      .select('author')
      .eq('status', BlogPostStatus.PUBLISHED);

    if (error) {
      throw new Error(`Failed to fetch posts by author: ${error.message}`);
    }

    const authorCounts = data?.reduce((acc, post) => {
      const author = post.author || 'Unknown';
      acc[author] = (acc[author] || 0) + 1;
      return acc;
    }, {}) || {};

    return authorCounts;
  }

  async getRecentPosts(limit = 5) {
    const { data, error } = await this.serviceSupabase
      .from('blog_posts')
      .select('*')
      .eq('status', BlogPostStatus.PUBLISHED)
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to fetch recent posts: ${error.message}`);
    }

    return data || [];
  }

  async publishPost(id: string) {
    return this.updateStatus(id, BlogPostStatus.PUBLISHED);
  }

  async archivePost(id: string) {
    return this.updateStatus(id, BlogPostStatus.ARCHIVED);
  }

  // Alias methods for controller compatibility
  async getBlogStats() {
    return this.getStatistics();
  }

  async findById(id: string) {
    return this.findOne(id);
  }

  async getPopularTags(limit = 10) {
    const { data, error } = await this.serviceSupabase
      .from('blog_posts')
      .select('tags')
      .eq('status', BlogPostStatus.PUBLISHED);

    if (error) {
      throw new Error(`Failed to fetch popular tags: ${error.message}`);
    }

    const tagCounts: Record<string, number> = {};
    data?.forEach(post => {
      if (post.tags && Array.isArray(post.tags)) {
        post.tags.forEach((tag: string) => {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        });
      }
    });

    return Object.entries(tagCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([tag, count]) => ({ tag, count }));
  }
}
