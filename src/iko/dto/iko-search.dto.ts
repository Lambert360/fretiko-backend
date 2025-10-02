import { IsString, IsOptional, IsNumber, IsEnum, IsArray, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';

// Search DTOs for Iko function calling
export class IkoSearchProductsDto {
  @IsString()
  query: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => value ? parseFloat(value) : undefined)
  minPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => value ? parseFloat(value) : undefined)
  maxPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  @Transform(({ value }) => value ? parseInt(value) : 10)
  limit?: number = 10;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => value ? parseInt(value) : 1)
  page?: number = 1;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class IkoSearchServicesDto {
  @IsString()
  query: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => value ? parseFloat(value) : undefined)
  minPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => value ? parseFloat(value) : undefined)
  maxPrice?: number;

  @IsOptional()
  @IsString()
  duration?: string; // e.g., "1-2 hours", "30 minutes"

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  @Transform(({ value }) => value ? parseInt(value) : 10)
  limit?: number = 10;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => value ? parseInt(value) : 1)
  page?: number = 1;
}

export class IkoSearchUsersDto {
  @IsString()
  query: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  userType?: 'seller' | 'rider' | 'buyer' | 'all';

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  @Transform(({ value }) => value ? parseInt(value) : 10)
  limit?: number = 10;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => value ? parseInt(value) : 1)
  page?: number = 1;
}

export class IkoRecommendationsDto {
  @IsEnum(['products', 'services', 'mixed'])
  type: 'products' | 'services' | 'mixed';

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  context?: string; // e.g., "budget_friendly", "premium", "trending"

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  @Transform(({ value }) => value ? parseInt(value) : 10)
  limit?: number = 10;
}

// Response interfaces for AI consumption
export interface IkoSearchResult {
  query: string;
  type: 'products' | 'services' | 'users';
  results: any[];
  count: number;
  hasMore: boolean;
  suggestions?: string[];
  userContext?: {
    preferredCategories?: string[];
    budgetRange?: number;
    locationPreference?: string;
  };
}

export interface IkoRecommendationResult {
  type: 'products' | 'services' | 'mixed';
  recommendations: any[];
  reason: string;
  userContext: {
    preferredCategories: string[];
    recentSearches: string[];
    budgetRanges: { [category: string]: number };
  };
}

// Structured data for AI function calling
export interface IkoProductResult {
  id: string;
  title: string;
  description: string;
  price: number;
  originalPrice?: number;
  discount?: number;
  category: string;
  seller: {
    id: string;
    name: string;
    rating: number;
  };
  images: string[];
  rating: number;
  reviewCount: number;
  availability: string;
  location: string;
  tags: string[];
  isRecommended: boolean;
}

export interface IkoServiceResult {
  id: string;
  title: string;
  description: string;
  price: number;
  duration: string;
  category: string;
  provider: {
    id: string;
    name: string;
    rating: number;
    completedJobs: number;
  };
  images: string[];
  rating: number;
  reviewCount: number;
  availability: string;
  location: string;
  tags: string[];
  isRecommended: boolean;
}

export interface IkoUserResult {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatar: string;
  location: string;
  isSeller: boolean;
  isRider: boolean;
  rating: number;
  connectionStatus: 'connected' | 'pending' | 'not_connected';
  mutualConnections: number;
}

// Function calling schemas for Gemini AI
export const IkoSearchFunctionSchemas = {
  searchProducts: {
    name: 'search_products',
    description: 'Search for products on the platform. Use this when users ask about buying, finding, or looking for physical items.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for products (e.g., "iPhone 15", "gaming laptop", "red dress")',
        },
        category: {
          type: 'string',
          description: 'Product category (e.g., "electronics", "fashion", "home")',
        },
        location: {
          type: 'string',
          description: 'Location preference for search (e.g., "nearby", "Lagos", "Abuja")',
        },
        minPrice: {
          type: 'number',
          description: 'Minimum price filter in Naira',
        },
        maxPrice: {
          type: 'number',
          description: 'Maximum price filter in Naira',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (1-50, default: 10)',
          default: 10,
        },
      },
      required: ['query'],
    },
  },

  searchServices: {
    name: 'search_services',
    description: 'Search for services on the platform. Use this when users ask about booking, hiring, or finding service providers.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for services (e.g., "hair styling", "web development", "house cleaning")',
        },
        category: {
          type: 'string',
          description: 'Service category (e.g., "beauty", "tech", "cleaning", "repair")',
        },
        location: {
          type: 'string',
          description: 'Location preference for search (e.g., "nearby", "Lagos", "Abuja")',
        },
        minPrice: {
          type: 'number',
          description: 'Minimum price filter in Naira',
        },
        maxPrice: {
          type: 'number',
          description: 'Maximum price filter in Naira',
        },
        duration: {
          type: 'string',
          description: 'Expected duration (e.g., "1 hour", "2-3 hours", "1 day")',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (1-50, default: 10)',
          default: 10,
        },
      },
      required: ['query'],
    },
  },

  searchUsers: {
    name: 'search_users',
    description: 'Search for users on the platform. Use this when users want to find people, sellers, or service providers.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for users (e.g., username, name, business name)',
        },
        location: {
          type: 'string',
          description: 'Location preference for search',
        },
        userType: {
          type: 'string',
          enum: ['seller', 'rider', 'buyer', 'all'],
          description: 'Type of user to search for',
          default: 'all',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (1-50, default: 10)',
          default: 10,
        },
      },
      required: ['query'],
    },
  },

  getRecommendations: {
    name: 'get_recommendations',
    description: 'Get personalized recommendations based on user preferences and behavior.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['products', 'services', 'mixed'],
          description: 'Type of recommendations to get',
        },
        category: {
          type: 'string',
          description: 'Specific category for recommendations',
        },
        context: {
          type: 'string',
          enum: ['budget_friendly', 'premium', 'trending', 'popular'],
          description: 'Context for recommendations',
        },
        limit: {
          type: 'number',
          description: 'Number of recommendations to return (1-20, default: 10)',
          default: 10,
        },
      },
      required: ['type'],
    },
  },
};