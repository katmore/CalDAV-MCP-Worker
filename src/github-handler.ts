import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from "./utils";
import { isAllowedLogin } from "./checks";
import {
	addApprovedClient,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	// Check if client is already approved
	if (await isClientApproved(c.req.raw, clientId, env.COOKIE_ENCRYPTION_KEY)) {
		// Skip approval dialog but still create secure state bound to this browser
		const { stateToken, setCookie: stateCookie } = await createOAuthState(oauthReqInfo, env.COOKIE_ENCRYPTION_KEY);
		return redirectToGithub(c.req.raw, stateToken, { "Set-Cookie": stateCookie });
	}

	// Generate CSRF protection for the approval form
	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "Private calendar access for the configured owner.",
			logo: "https://avatars.githubusercontent.com/u/314135?s=200&v=4",
			name: "Private Calendar",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		// Read form data once
		const formData = await c.req.raw.formData();

		// Validate CSRF token
		validateCSRFToken(formData, c.req.raw);

		// Extract state from form data
		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		// Add client to approved list
		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		// Create OAuth state bound to this browser
		const { stateToken, setCookie: stateCookie } = await createOAuthState(state.oauthReqInfo, c.env.COOKIE_ENCRYPTION_KEY);

		// Set both cookies: approved client list + signed state
		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", stateCookie);

		return redirectToGithub(c.req.raw, stateToken, headers);
	} catch (error: any) {

		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Unexpected non-OAuth error
		return c.text("Internal server error", 500);
	}
});

async function redirectToGithub(
	request: Request,
	stateToken: string,
	headers: HeadersInit,
) {
	const responseHeaders = new Headers(headers);
 responseHeaders.set('Location', getUpstreamAuthorizeUrl({
   client_id: env.GITHUB_CLIENT_ID,
   redirect_uri: new URL('/callback', request.url).href,
   scope: 'read:user', state: stateToken,
   upstream_url: 'https://github.com/login/oauth/authorize',
 }));
 return new Response(null, { headers: responseHeaders, status: 302 });
}

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from GitHub after user authentication.
 * It exchanges the temporary code for an access token, then stores some
 * user metadata & the auth token as part of the 'props' on the token passed
 * down to the client. It ends by redirecting the client back to _its_ callback URL
 *
 * SECURITY: This endpoint validates that the state parameter from GitHub
 * matches the signed __Host-OAUTH_STATE cookie, which proves our server
 * created the state and that THIS browser consented to it.
 *
 * This prevents CSRF attacks where an attacker's state token is injected
 * into a victim's OAuth flow.
 */
app.get("/callback", async (c) => {
	// Validate OAuth state against the signed state cookie
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.COOKIE_ENCRYPTION_KEY);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Unexpected non-OAuth error
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	// Exchange the code for an access token
	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.GITHUB_CLIENT_ID,
		client_secret: c.env.GITHUB_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) return errResponse;

	// Fetch the user info from GitHub
	const userResponse = await fetch("https://api.github.com/user", {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "caldav-mcp-worker",
		},
	});
	if (!userResponse.ok) {
		return c.text("Could not verify GitHub account", 502);
	}
	const { login, name, email } = (await userResponse.json()) as { login: string; name: string; email: string };
	if (!isAllowedLogin(login, c.env.ALLOWED_GITHUB_LOGIN)) {
		return c.text("Not authorized", 403);
	}

	// Return back to the MCP client a new token
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: name,
		},
		// This will be available on this.props inside MyMCP
		props: {
			email,
			login,
			name,
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: login,
	});

	// Clear the session binding cookie (one-time use) by creating response with headers
	const headers = new Headers({ Location: redirectTo });
	headers.set("Set-Cookie", clearSessionCookie);

	return new Response(null, {
		status: 302,
		headers,
	});
});

export { app as GitHubHandler };
