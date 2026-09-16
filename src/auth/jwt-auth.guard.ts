import { Injectable, UnauthorizedException, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { RequestWithUser, JwtPayload } from '../shared/types';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
  ) {
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const type = context.getType<'http' | 'ws'>();
    let token: string | undefined;
    let attachUser: (user: any) => void;

    if (type === 'ws') {
      const client = context.switchToWs().getClient<any>();
      token = client.handshake?.auth?.token;
      if (!token) {
        token = client.handshake?.query?.token as string | undefined;
      }
      attachUser = (user) => {
        client.user = user;
      };
    } else {
      const request = context.switchToHttp().getRequest<RequestWithUser>();
      const authHeader = request.headers.authorization;
      token = authHeader?.replace('Bearer ', '');
      attachUser = (user) => {
        request.user = user;
        request.supabaseUser = null;
        request.supabaseToken = token;
      };
    }

    if (!token) {
      throw new UnauthorizedException('No authorization token');
    }

    try {
      const decoded = this.jwtService.verify<JwtPayload>(token);

      if (!decoded || typeof decoded !== 'object' || !(decoded as any).sub) {
        throw new UnauthorizedException('Invalid token payload');
      }

      attachUser({
        sub: (decoded as any).sub,
        id: (decoded as any).sub,
        email: (decoded as any).email,
        type: (decoded as any).type,
        iat: (decoded as any).iat,
        exp: (decoded as any).exp,
      });

      return true;
    } catch (error: any) {
      console.error(' JWT validation failed:', {
        message: error.message,
        name: error.name,
      });

      throw new UnauthorizedException('Invalid token');
    }
  }
}