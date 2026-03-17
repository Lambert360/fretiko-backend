import { Controller, Get, Query } from '@nestjs/common';
import { RateProviderService } from './rate-provider.service';

@Controller('rates')
export class RateTestController {
  constructor(private readonly rateProviderService: RateProviderService) {}

  @Get('test')
  async testRate(@Query('from') from: string, @Query('to') to: string, @Query('amount') amount?: number) {
    try {
      const rate = await this.rateProviderService.getExchangeRate(from, to, amount);
      return {
        success: true,
        rate,
        message: `Rate from ${from} to ${to} fetched successfully from ${rate.provider}`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        message: 'Failed to fetch rate',
      };
    }
  }

  @Get('health')
  async getProviderHealth() {
    const health = await this.rateProviderService.getProviderHealth();
    const stats = this.rateProviderService.getCacheStats();
    
    return {
      providers: health,
      cache: stats,
      message: 'Rate provider health status',
    };
  }

  @Get('cache/clear')
  clearCache() {
    this.rateProviderService.clearCache();
    return {
      success: true,
      message: 'Rate cache cleared',
    };
  }
}
