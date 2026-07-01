import {Controller, Get} from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  health() {
    return {ok: true, service: 'schedlio-api'};
  }

  @Get('privacy')
  privacy() {
    return {
      app: 'Schedlio',
      updatedAt: '2026-07-01',
      summary:
        'Schedlio collects account email, profile info, and content you upload to schedule social posts. Media is stored on our servers. We do not sell personal data.',
      dataCollected: [
        'Email and name for authentication',
        'Profile photo (optional upload)',
        'Post captions, images, and schedule data',
        'Connected social account names (Facebook, Instagram, YouTube)',
      ],
      permissions: [
        'Internet — API and social publishing',
        'Photos/Videos — pick media for posts and profile photo',
      ],
      contact: 'support@chapaimango.online',
      policyUrl: 'https://postapi.chapaimango.online/v1/privacy',
    };
  }
}

