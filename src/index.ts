import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { CalendarServer, type CalendarEnv, type Props } from './calendar';
import { GitHubHandler } from './github-handler';
import { isAllowedLogin } from './checks';

const options = {
  apiHandler: { async fetch(request: Request, env: Env & CalendarEnv, ctx: ExecutionContext) {
    const props = ctx.props as Props | undefined;
    if (!props || !isAllowedLogin(props.login, env.ALLOWED_GITHUB_LOGIN)) return new Response('Forbidden', {status: 403});
    return createMcpHandler(async () => { const calendar = new CalendarServer(env, props); await calendar.init(); return calendar.server; })(request, env, ctx);
  } },
  allowPlainPKCE: false,
  // Apps identify themselves with a client metadata document URL, which the current MCP
  // spec prefers and which stores nothing until a sign-in succeeds.
  clientIdMetadataDocumentEnabled: true,
  apiRoute: '/mcp',
  authorizeEndpoint: '/authorize',
  defaultHandler: GitHubHandler as any,
  tokenEndpoint: '/token',
};

// Dynamic client registration (/register) stores every registration in KV before anyone
// signs in, so it is off unless ALLOW_CLIENT_REGISTRATION is "true". Apps registered
// earlier keep working either way.
const withoutRegistration = new OAuthProvider(options);
const withRegistration = new OAuthProvider({ ...options, clientRegistrationEndpoint: '/register' });

export default {
  fetch(request: Request, env: Env & { ALLOW_CLIENT_REGISTRATION?: string }, ctx: ExecutionContext) {
    const provider = env.ALLOW_CLIENT_REGISTRATION === 'true' ? withRegistration : withoutRegistration;
    return provider.fetch(request, env, ctx);
  },
};
