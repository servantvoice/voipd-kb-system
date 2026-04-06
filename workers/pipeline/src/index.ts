export { PipelineWorkflow } from "./pipeline-workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /process — start the pipeline workflow
    if (request.method === "POST" && url.pathname === "/process") {
      const secret = request.headers.get("X-Crawl-Secret");
      if (!secret || secret !== env.CRAWL_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      let payload: Record<string, unknown> = {};
      try {
        payload = (await request.json()) as Record<string, unknown>;
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      const crawlDatePrefix = payload.crawlDatePrefix as string;
      if (!crawlDatePrefix) {
        return Response.json({ error: "Missing crawlDatePrefix" }, { status: 400 });
      }

      const instance = await env.PIPELINE_WORKFLOW.create({
        params: {
          crawlDatePrefix,
          pageCount: (payload.pageCount as number) ?? 0,
          missedPages: (payload.missedPages as number) ?? 0,
          sitemapTotal: (payload.sitemapTotal as number) ?? 0,
          filteredTotal: (payload.filteredTotal as number) ?? 0,
        },
      });

      return Response.json({
        message: "Pipeline workflow started",
        instanceId: instance.id,
        crawlDatePrefix,
      });
    }

    // GET /status/:id — check workflow instance status
    if (request.method === "GET" && url.pathname.startsWith("/status/")) {
      const instanceId = url.pathname.replace("/status/", "");
      if (!instanceId) {
        return Response.json({ error: "Missing instance ID" }, { status: 400 });
      }

      try {
        const instance = await env.PIPELINE_WORKFLOW.get(instanceId);
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

    // GET / — health check
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "kb-pipeline",
        status: "ok",
        endpoints: {
          "POST /process": "Start pipeline (requires X-Crawl-Secret header + crawlDatePrefix in body)",
          "GET /status/:id": "Check workflow instance status",
        },
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
