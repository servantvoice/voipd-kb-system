import { sendEmail } from "../../../shared/email";

export { PipelineWorkflow } from "./pipeline-workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /notify — send a notification email (shared CRAWL_SECRET auth).
    // Used by the crawl worker (via service binding) to surface failures
    // through the pipeline's existing email configuration.
    if (request.method === "POST" && url.pathname === "/notify") {
      const secret = request.headers.get("X-Crawl-Secret");
      if (!secret || secret !== env.CRAWL_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      let body: { subject?: string; html?: string } = {};
      try {
        body = (await request.json()) as { subject?: string; html?: string };
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      if (!body.subject || !body.html) {
        return Response.json({ error: "Missing subject or html" }, { status: 400 });
      }

      try {
        await sendEmail(env, body.subject, body.html);
        return Response.json({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 502 });
      }
    }

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
          "POST /notify": "Send notification email (requires X-Crawl-Secret header + {subject, html} body)",
          "GET /status/:id": "Check workflow instance status",
        },
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
