import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from '../shared/types';



/**

 * Optional JWT Auth Guard

 * Attempts to validate JWT token if present, but allows request to continue if not

 * Useful for endpoints that work for both authenticated and unauthenticated users

 */

@Injectable()

export class OptionalJwtAuthGuard implements CanActivate {

  constructor(private jwtService: JwtService) {}



  async canActivate(context: ExecutionContext): Promise<boolean> {

    const request = context.switchToHttp().getRequest();

    const authHeader = request.headers.authorization;



    // If no auth header, allow request to continue but without user info

    if (!authHeader) {

      console.log('🔓 Optional auth: No authorization header, continuing without user');

      return true;

    }



    const token = authHeader.replace('Bearer ', '');



    try {

      console.log('🔐 Optional auth: Validating token with custom JWT...');

      const decoded = this.jwtService.verify<JwtPayload>(token);

      if (!decoded || typeof decoded !== 'object' || !(decoded as any).sub) {
        console.warn('⚠️ Optional auth: Token payload invalid, continuing without user');
        return true;
      }

      console.log('✅ Optional auth: Token validated for user:', (decoded as any).sub);

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

      // Log error but don't throw - allow request to continue without user

      console.warn('⚠️ Optional auth: Token validation error, continuing without user:', error.message);

      return true;

    }

  }

}

