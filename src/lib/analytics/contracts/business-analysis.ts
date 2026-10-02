/**
 * P1.5-W01 — Contract `business-analysis/0.1`.
 *
 * Strict output của AI Business Analyst (report_status luôn `draft` trong 0.1).
 * Validator KHÔNG gọi AI: nó kiểm tra output so với context của packet
 * (evidence tồn tại, subject thuộc scope, confidence gate, claim số phải ground được).
 *
 * Module thuần: không đọc DB, không gọi mạng, không chứa secret.
 */

import { z } from "zod";

import {
  BUSINESS_ANALYSIS_VERSION,
  CONFIDENCE_LEVELS,
  EVIDENCE_ID_RE,
  FINDING_CATEGORIES,
  FINDING_ID_RE,
  MAX_FINDINGS,
  MAX_RECOMMENDED_ACTIONS,
  MIN_FINDINGS_WHEN_SUFFICIENT,
  PERIOD_REF_RE,
  SCOPE_SUBJECT_REF,
  SUBJECT_REF_RE,
  extractNumericTokens,
  groundableNumberSet,
  isGroundedNumber,
  scanProhibitedContent,
} from "./shared.mjs";

const findingSchema = z.strictObject({
  finding_id: z.string().regex(FINDING_ID_RE),
  category: z.enum(FINDING_CATEGORIES),
  subject_ref: z.string().regex(SUBJECT_REF_RE),
  headline: z.string().min(8).max(200),
  analysis: z.string().min(20).max(1500),
  evidence_refs: z.array(z.string().regex(EVIDENCE_ID_RE)).min(1).max(12),
  confidence: z.enum(CONFIDENCE_LEVELS),
  limitations: z.array(z.string().min(3).max(300)).max(8),
  recommended_action: z.string().min(5).max(300).nullable(),
});

export const businessAnalysisSchema = z.strictObject({
  contract_version: z.literal(BUSINESS_ANALYSIS_VERSION),
  period_ref: z.string().regex(PERIOD_REF_RE),
  report_status: z.literal("draft"),
  executive_analysis: z.string().min(40).max(3000),
  findings: z.array(findingSchema).min(1).max(MAX_FINDINGS),
  overall_limitations: z.array(z.string().min(3).max(300)).max(10),
});

export type BusinessAnalysis = z.infer<typeof businessAnalysisSchema>;
export type BusinessFinding = z.infer<typeof findingSchema>;
export type BusinessFindingCategory = z.infer<typeof findingSchema>["category"];

export type ContractValidationError = { ok: false; code: string; message: string; path?: string };
export type ContractValidationResult<T> = { ok: true; value: T } | ContractValidationError;

/** Context lấy từ packet đã validate — truyền vào thay vì import chéo module. */
export interface BusinessAnalysisContext {
  periodRef: string;
  /** Mọi evidence_id có trong packet. */
  evidenceIds: string[];
  /** Subject ref thuộc scope (KHÔNG gồm "scope"). */
  subjectRefs: string[];
  /** Evidence kèm value/unit để đối chiếu claim số. */
  evidence: { evidence_id: string; value: number; unit: string }[];
  /** Sufficiency key CHƯA đạt baseline. Rỗng = baseline đạt. */
  insufficientKeys: string[];
}

function firstIssue(error: z.ZodError): ContractValidationError {
  const issue = error.issues[0];
  const path = issue?.path?.join(".") ?? "";
  const raw = issue?.message ?? "INVALID";
  const isUnknownKey = issue?.code === "unrecognized_keys" || /unrecognized key/i.test(raw);
  const code = isUnknownKey ? "UNKNOWN_FIELD" : issue?.code === "custom" ? raw : "SCHEMA_INVALID";
  return { ok: false, code, message: raw + (path ? " @ " + path : ""), path };
}

/**
 * Validate output analysis (1) nội dung bị cấm, (2) strict schema,
 * (3) ràng buộc chéo với packet: evidence tồn tại, subject trong scope,
 * confidence gate theo sufficiency, claim số phải ground được.
 */
export function validateBusinessAnalysis(
  input: unknown,
  context: BusinessAnalysisContext
): ContractValidationResult<BusinessAnalysis> {
  const fail = (code: string, message: string, path?: string): ContractValidationError => ({ ok: false, code, message, path });

  const prohibited = scanProhibitedContent(input);
  if (prohibited) return { ok: false, code: prohibited.code, message: prohibited.message, path: prohibited.path };

  const parsed = businessAnalysisSchema.safeParse(input);
  if (!parsed.success) return firstIssue(parsed.error);
  const report = parsed.data;

  if (report.period_ref !== context.periodRef) {
    return fail("PERIOD_REF_MISMATCH", "period_ref không khớp packet", "period_ref");
  }

  const evidenceIds = new Set(context.evidenceIds);
  const subjectRefs = new Set(context.subjectRefs);
  const evidenceById = new Map(context.evidence.map((e) => [e.evidence_id, e]));

  const findingIds = new Set<string>();
  let recommendedActions = 0;

  for (let i = 0; i < report.findings.length; i++) {
    const finding = report.findings[i];
    const at = "findings[" + i + "]";

    if (findingIds.has(finding.finding_id)) return fail("DUPLICATE_FINDING_ID", "finding_id trùng: " + finding.finding_id, at);
    findingIds.add(finding.finding_id);

    if (finding.subject_ref !== SCOPE_SUBJECT_REF && !subjectRefs.has(finding.subject_ref)) {
      return fail("SUBJECT_OUT_OF_SCOPE", "subject ngoài scope: " + finding.subject_ref, at);
    }

    for (const ref of finding.evidence_refs) {
      if (!evidenceIds.has(ref)) return fail("DANGLING_EVIDENCE_REF", "evidence_ref không tồn tại: " + ref, at);
    }

    if (finding.category === "risk" && finding.limitations.length === 0) {
      return fail("RISK_WITHOUT_LIMITATIONS", "finding risk phải nêu limitation (sample size/coverage/concentration)", at);
    }

    if (context.insufficientKeys.length > 0 && finding.confidence === "high") {
      return fail("HIGH_CONFIDENCE_WITHOUT_SUFFICIENCY", "confidence high khi baseline chưa đạt (" + context.insufficientKeys.join(",") + ")", at);
    }

    if (finding.recommended_action !== null) {
      recommendedActions += 1;
      if (recommendedActions > MAX_RECOMMENDED_ACTIONS) {
        return fail("TOO_MANY_RECOMMENDED_ACTIONS", "quá " + MAX_RECOMMENDED_ACTIONS + " recommended_action", at);
      }
    }

    // Claim số phải đối chiếu được evidence được trích dẫn.
    const ground = [];
    for (const ref of finding.evidence_refs) {
      const ev = evidenceById.get(ref);
      if (ev) ground.push(...groundableNumberSet(ev));
    }
    const text = [finding.headline, finding.analysis, finding.recommended_action ?? ""].join(" ");
    for (const token of extractNumericTokens(text)) {
      const norm = token.replace("%", "").replace(",", ".");
      if (/^(?:19|20)\d{2}$/.test(norm)) continue; // năm trong câu chữ
      const num = Number(norm);
      if (!Number.isFinite(num)) continue;
      if (!isGroundedNumber(num, ground)) {
        return fail("UNGROUNDED_NUMERIC_CLAIM", "số " + token + " không khớp evidence được trích dẫn", at);
      }
    }
  }

  if (context.insufficientKeys.length === 0 && report.findings.length < MIN_FINDINGS_WHEN_SUFFICIENT) {
    return fail("FINDINGS_BELOW_MINIMUM", "baseline đạt nhưng chỉ có " + report.findings.length + " finding (tối thiểu " + MIN_FINDINGS_WHEN_SUFFICIENT + ")", "findings");
  }

  return { ok: true, value: report };
}
