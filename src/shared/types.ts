import { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      supabaseUser?: any;
      supabaseToken?: string;
    }
  }
}

export interface JwtPayload {
  sub: string;
  email?: string;
  type?: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedUser extends JwtPayload {
  sub: string;
  id: string;
  email?: string;
  type?: string;
  isAdmin?: boolean;
  iat: number;
  exp: number;
}

export interface RequestWithUser extends Request {}
