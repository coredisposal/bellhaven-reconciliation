import handler from "vinext/server/fetch-handler";

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const response = await handler.fetch(request, env, ctx);
    // Copy only the response envelope: streamed bodies and session cookies
    // remain intact, including for API and framework error responses.
    const protectedResponse = new Response(response.body, response);
    protectedResponse.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return protectedResponse;
  },
};
