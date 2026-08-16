import { 
  Controller, 
  Get, 
  Query,
  Param,
  HttpStatus
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AboutContentService } from '../services/about-content.service';

@ApiTags('Public - About Content')
@Controller('public/website-content/about-content')
export class PublicAboutContentController {
  constructor(private readonly aboutContentService: AboutContentService) {}

  @Get()
  @ApiOperation({ summary: 'Get published about content sections' })
  @ApiResponse({ status: HttpStatus.OK, description: 'About content sections retrieved successfully' })
  async findPublished(@Query() query: any) {
    return this.aboutContentService.findPublished(query);
  }

  @Get('section/:section')
  @ApiOperation({ summary: 'Get published about content by section' })
  @ApiResponse({ status: HttpStatus.OK, description: 'About content section retrieved successfully' })
  async findBySection(@Param('section') section: string) {
    return this.aboutContentService.findBySection(section);
  }
}
