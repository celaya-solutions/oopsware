import { FileText } from "lucide-react";
import { ProjectRequestError } from "../projects/projectApi";
import { downloadRunReport, type ReportFormat } from "./reportApi";

/** "Report this run": a one-run HTML or PDF download, never saved. Sits in an `.inline-actions` row. */
export function RunReportButtons({
  workspace,
  runId,
  disabled = false,
  task,
  fail,
}: {
  workspace: string;
  runId: string;
  disabled?: boolean;
  task: (label: string, fn: () => Promise<void>) => Promise<void>;
  fail: (message: string) => void;
}) {
  const build = (format: ReportFormat) =>
    void task(
      format === "pdf" ? "Printing PDF report" : "Building report",
      async () => {
        try {
          await downloadRunReport(workspace, runId, {
            format,
            includeAppendix: false,
          });
        } catch (cause) {
          if (cause instanceof ProjectRequestError) fail(cause.message);
          else throw cause;
        }
      },
    );
  return (
    <>
      <button disabled={disabled} onClick={() => build("html")}>
        <FileText size={14} />
        Report this run
      </button>
      <button
        disabled={disabled}
        aria-label="Report this run as PDF"
        onClick={() => build("pdf")}
      >
        PDF
      </button>
    </>
  );
}
