import type { WorkReportTemplateSchema } from "@/lib/work-reports/contracts.ts";
import { formatReaderDateTime, renderWorkReportFieldValue } from "@/lib/work-reports/reader-ui-model.ts";

/**
 * Shared read-only report renderer. Used by the BoD/Admin reader and the review inbox so
 * there is exactly one read-only path (selects show labels, booleans show Có/Không,
 * missing values show "—", long text wraps, and no raw JSON or technical key is rendered
 * as a primary label).
 */
export function ReportReadonlyContent({
  schema,
  payload,
}: {
  schema: WorkReportTemplateSchema;
  payload: Record<string, unknown>;
}) {
  return (
    <div className="space-y-4">
      {schema.sections.map((section) => (
        <fieldset key={section.section_key} className="space-y-3 rounded-xl border border-border p-4">
          <legend className="px-1 text-sm font-semibold">{section.label}</legend>
          {section.description ? <p className="text-sm text-muted">{section.description}</p> : null}
          {section.fields.map((field) => (
            <div key={field.field_key} className="space-y-1">
              <p className="text-sm font-medium">{field.label}</p>
              <p className="whitespace-pre-wrap break-words text-sm text-muted">
                {renderWorkReportFieldValue(field, payload[field.field_key])}
              </p>
            </div>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

export function ReportRevisionList({
  revisions,
  currentRevisionId,
}: {
  revisions: readonly { revision_id: string; revision_no: number; created_at: string }[];
  currentRevisionId: string | null;
}) {
  if (revisions.length === 0) return null;
  return (
    <details>
      <summary className="cursor-pointer rounded-md py-1 text-sm font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        Lịch sử các lần nộp ({revisions.length})
      </summary>
      <ol className="mt-2 space-y-2 text-sm text-muted">
        {revisions.map((revision) => (
          <li key={revision.revision_id}>
            Lần {revision.revision_no} · {formatReaderDateTime(revision.created_at)}
            {revision.revision_id === currentRevisionId ? " · bản hiện hành" : ""}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function ReportReviewHistory({
  event,
}: {
  event: { decision: string; reason: string | null; reviewed_at: string; revision_no?: number } | null;
}) {
  if (!event) return null;
  return (
    <details>
      <summary className="cursor-pointer rounded-md py-1 text-sm font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        Quyết định duyệt gần nhất
      </summary>
      <p className="mt-2 text-sm text-muted">
        {event.decision === "APPROVED" ? "Đã duyệt" : event.decision === "REJECTED" ? "Bị từ chối" : event.decision}
        {event.revision_no !== undefined ? ` · lần ${event.revision_no}` : ""}
        {` · ${formatReaderDateTime(event.reviewed_at)}`}
        {event.reason ? ` · ${event.reason}` : ""}
      </p>
    </details>
  );
}
