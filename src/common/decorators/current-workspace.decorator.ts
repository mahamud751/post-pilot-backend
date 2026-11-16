import {createParamDecorator, ExecutionContext} from '@nestjs/common';
import type {WorkspaceContext} from '../../workspaces/workspace.guard';

/** The workspace resolved by WorkspaceGuard. Only valid on routes guarded by it. */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.workspace as WorkspaceContext;
  },
);
