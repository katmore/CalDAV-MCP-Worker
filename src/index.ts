import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { CalendarServer, type CalendarEnv, type Props } from './calendar';
import { GitHubHandler } from './github-handler';
import { isAllowedLogin } from './safety';

export default new OAuthProvider({
  apiHandler: { async fetch(request: Request, env: Env & CalendarEnv, ctx: ExecutionContext) {
    const props = ctx.props as Props | undefined;
    if (!props || !isAllowedLogin(props.login, env.ALLOWED_GITHUB_LOGIN)) return new Response('Forbidden', {status: 403});
    return createMcpHandler(async () => { const calendar = new CalendarServer(env, props); await calendar.init(); return calendar.server; })(request, env, ctx);
  } },
  allowPlainPKCE: false,
  apiRoute: '/mcp',
  authorizeEndpoint: '/authorize',
  clientRegistrationEndpoint: '/register',
  defaultHandler: GitHubHandler as any,
  tokenEndpoint: '/token',
});
