import { Injectable, UnauthorizedException, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RequestWithUser, JwtPayload } from '../shared/types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
  ) {
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const authHeader = request.headers.authorization;

    console.log(' Auth header received:', authHeader ? 'Present' : 'Missing');

    if (!authHeader) {
      throw new UnauthorizedException('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');

    console.log(' Token details:');
    console.log('  - Length:', token.length);
    console.log('  - First 30 chars:', token.substring(0, 30) + '...');
    console.log('  - Ends with:', '...' + token.substring(token.length - 10));

    try {
      console.log(' Validating custom JWT token...');

      const decoded = this.jwtService.verify<JwtPayload>(token);

      if (!decoded || typeof decoded !== 'object' || !(decoded as any).sub) {
        throw new UnauthorizedException('Invalid token payload');
      }

      console.log(' Custom JWT validated for user:', (decoded as any).sub);

      // Attach user to request
      request.user = { 
        sub: (decoded as any).sub,
        id: (decoded as any).sub,
        email: (decoded as any).email,
        type: (decoded as any).type,
        iat: (decoded as any).iat,
        exp: (decoded as any).exp,
      };

      request.supabaseUser = null;
      request.supabaseToken = token;

      return true;
    } catch (error) {
      console.error(' Custom JWT validation failed:', {
        message: error.message,
        name: error.name,
        stack: error.stack?.split('\n')[0]
      });

      throw new UnauthorizedException('Invalid token');
    }
  }
}