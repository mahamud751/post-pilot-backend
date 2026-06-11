import {Controller, Get, Param, Patch, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {NotificationsService} from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(@CurrentUserId() userId: string) {
    return this.notificationsService.findAll(userId).then(notifications => ({
      notifications,
      unreadCount: notifications.filter(n => !n.read).length,
    }));
  }

  @Get('unread-count')
  unreadCount(@CurrentUserId() userId: string) {
    return this.notificationsService.unreadCount(userId).then(count => ({count}));
  }

  @Patch('read-all')
  markAllRead(@CurrentUserId() userId: string) {
    return this.notificationsService.markAllRead(userId);
  }

  @Patch(':id/read')
  markRead(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.notificationsService.markRead(userId, id);
  }
}
