import { accountIdProperty, createTool, emptyParameters } from "./common.js";
import { encodePath, normalizeReportForm } from "../utils.js";

export function reportTools({ client, sdk }) {
  return [
    createTool(
      sdk,
      {
        name: "finam_generate_report",
        description: "Start Finam account report generation for a date range. Returns a report ID to poll.",
        category: "action",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
            date_begin: { type: "string", description: "Report start date, ISO date string." },
            date_end: { type: "string", description: "Report end date, ISO date string." },
            report_form: { type: "string", description: "short, long, or REPORT_FORM_*." },
          },
          required: ["account_id", "date_begin", "date_end"],
        },
      },
      async (params) => {
        const data = await client.post("/v1/report", {
          account_id: params.account_id,
          date_range: {
            date_begin: params.date_begin,
            date_end: params.date_end,
          },
          report_form: normalizeReportForm(params.report_form ?? "short"),
        });
        return { report_id: data.report_id ?? null, status: "processing", raw: data };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_report_status",
        description: "Poll Finam account report generation status by report ID and return download URL when ready.",
        parameters: {
          type: "object",
          properties: {
            report_id: { type: "string", description: "Report ID returned by finam_generate_report." },
          },
          required: ["report_id"],
        },
      },
      async (params) => {
        const data = await client.get(`/v1/report/${encodePath(params.report_id)}/info`);
        const info = data.info ?? data;
        return {
          report_id: info.report_id ?? params.report_id,
          status: info.status ?? null,
          download_url: info.url ?? null,
          account_id: info.account_id ?? null,
          date_range: info.date_range ?? null,
          report_form: info.report_form ?? null,
          raw: data,
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_usage",
        description: "Get current Finam API usage metrics, including request quotas, remaining counts, and reset times.",
        parameters: emptyParameters,
      },
      async () => {
        const data = await client.get("/v1/usage");
        return {
          quotas: data.quotas ?? [],
          requests_today: data.requests_today ?? null,
          limit_daily: data.limit_daily ?? null,
          reset_time: data.reset_time ?? null,
        };
      }
    ),
  ];
}
