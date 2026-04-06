export { CrawlWorkflow } from "./crawl-workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/crawl") {
      const secret = request.headers.get("X-Crawl-Secret");
      if (!secret || secret !== env.CRAWL_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      let params: Record<string, unknown> = {};
      try {
        if (request.headers.get("content-type")?.includes("application/json")) {
          params = (await request.json()) as Record<string, unknown>;
        }
      } catch {
        // Empty body is fine
      }

      const instance = await env.CRAWL_WORKFLOW.create({
        params: {
          url: (params.url as string) ?? undefined,
          modifiedSince: (params.modifiedSince as string) ?? undefined,
          webhookUrl: (params.webhookUrl as string) ?? undefined,
        },
      });

      return Response.json({
        message: "Crawl workflow started",
        instanceId: instance.id,
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/status/")) {
      const instanceId = url.pathname.replace("/status/", "");
      if (!instanceId) {
        return Response.json({ error: "Missing instance ID" }, { status: 400 });
      }

      try {
        const instance = await env.CRAWL_WORKFLOW.get(instanceId);
        const status = await instance.status();
        return Response.json({
          instanceId,
          status: status.status,
          output: status.output,
          error: status.error,
        });
      } catch {
        return Response.json(
          { error: `Instance not found: ${instanceId}` },
          { status: 404 }
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "kb-crawler",
        status: "ok",
        endpoints: {
          "POST /crawl": "Start a new crawl (requires X-Crawl-Secret header)",
          "GET /status/:id": "Check workflow instance status",
        },
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const instance = await env.CRAWL_WORKFLOW.create({ params: {} });
    console.log(
      `Scheduled crawl started: instance=${instance.id}, cron=${controller.cron}, time=${new Date(controller.scheduledTime).toISOString()}`
    );
  },
};
