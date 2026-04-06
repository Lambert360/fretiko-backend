import { Request } from 'express';

export interface JwtPayload {
  sub: string;
  email?: string;
  type?: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedUser extends JwtPayload {
  sub: string;
  email: string;
  type?: string;
  iat: number;
  exp: number;
}

export interface RequestWithUser extends Request {
  user: AuthenticatedUser;
  supabaseUser?: any;
  supabaseToken?: string;
}
