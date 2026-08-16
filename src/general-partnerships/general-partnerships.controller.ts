import { Controller, Post, Body } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { PartnershipsService } from '../partnerships/partnerships.service'

@ApiTags('general-partnerships')
@Controller('general-partnerships')
export class GeneralPartnershipsController {
  constructor(private readonly partnershipsService: PartnershipsService) {}

  @Post()
  @ApiOperation({ summary: 'Submit general partnership application (public endpoint)' })
  @ApiResponse({ status: 201, description: 'Application created successfully' })
  async createGeneralApplication(@Body() applicationData: any) {
    return this.partnershipsService.createGeneralApplication(applicationData)
  }
}
