import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SoundsService } from './sounds.service';

/**
 * Sounds Controller
 *
 * Vendor-facing live-stream soundboard endpoints. Admin/platform sounds
 * are still managed via /gifts/admin/sounds (staff-only).
 *
 *   GET    /sounds/live-stream/library    → { platform, mine, primaries }
 *   POST   /sounds/live-stream            → upload a custom sound (multipart)
 *   DELETE /sounds/live-stream/:id        → delete own sound
 *   PUT    /sounds/live-stream/primaries  → set the 3 quick-play slots
 */
@Controller('sounds')
@UseGuards(JwtAuthGuard)
export class SoundsController {
  constructor(private readonly soundsService: SoundsService) {}

  @Get('live-stream/library')
  async getLibrary(@Request() req) {
    return this.soundsService.getLibrary(req.user.sub);
  }

  @Post('live-stream')
  @UseInterceptors(FileInterceptor('file'))
  async uploadSound(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
  ) {
    if (!file) {
      throw new BadRequestException('Audio file is required');
    }
    return this.soundsService.uploadSound(req.user.sub, file, name);
  }

  @Delete('live-stream/:id')
  async deleteSound(@Request() req, @Param('id') id: string) {
    return this.soundsService.deleteSound(req.user.sub, id);
  }

  @Put('live-stream/primaries')
  async setPrimaries(@Request() req, @Body() body: { primaries?: string[] }) {
    return this.soundsService.setPrimaries(req.user.sub, body?.primaries as any);
  }
}
