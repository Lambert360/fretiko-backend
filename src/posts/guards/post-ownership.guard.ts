import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PostsService } from '../posts.service';

@Injectable()
export class PostOwnershipGuard implements CanActivate {
  constructor(private postsService: PostsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const postId = request.params.id;

    if (!user || !postId) {
      throw new ForbiddenException('User or post ID not found');
    }

    const post = await this.postsService.findById(postId);
    
    if (!post) {
      throw new ForbiddenException('Post not found');
    }

    // Check if user owns the post or is admin
    if (post.userId !== user.id && !user.isAdmin) {
      throw new ForbiddenException('You do not have permission to modify this post');
    }

    // Attach post to request for use in controller
    request.post = post;
    
    return true;
  }
}
