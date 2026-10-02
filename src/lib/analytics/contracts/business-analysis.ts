/**
 * P1.5-W01 (+R1) — Contract `business-analysis/0.1`.
 *
 * Strict output của AI Business Analyst (report_status luôn `draft` trong 0.1).
 * Validator KHÔNG gọi AI: nó kiểm tra output so với context của packet
 * (evidence tồn tại, subject thuộc scope, confidence gate, team coverage,
 * và **unit-aware** numeric grounding cho cả executive_analysis lẫn findings).
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
  LIMITATION_PHRASES,
  MAX_FINDINGS,
  MAX_RECOMMENDED_ACTIONS,
  PERIOD_REF_RE,
  SCOPE_SUBJECT_REF,
  SUBJECT_REF_RE,
  TEAM_SUBJECT_REF_RE,
  extractIsoDates,
  extractNumericClaims,
  isGroundedClaim,
  mergeGroundingSets,
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
  executive_evidence_refs: z.array(z.string().regex(EVIDENCE_ID_RE)).min(1).max(12),
  findings: z.array(findingSchema).max(MAX_FINDINGS),
  overall_limitations: z.array(z.string().min(3).max(300)).max(10),
});

export type BusinessAnalysis = z.infer<typeof businessAnalysisSchema>;
export type BusinessFinding = z.infer<typeof findingSchema>;
export type BusinessFindingCategory = z.infer<typeof findingSchema>["category"];

export type ContractValidationError = { ok: false; code: string; message: string; path?: string };
export type ContractValidationResult<T> = { ok: true; value: T } | ContractValidationError;

export interface EvidenceLite {
  evidence_id: string;
  value: number;
  unit: string;
}

/** Context lấy từ packet đã validate — truyền vào thay vì import chéo module. */
export interface BusinessAnalysisContext {
  periodRef: string;
  /** Mọi evidence_id có trong packet. */
  evidenceIds: string[];
  /** Subject ref thuộc scope (KHÔNG gồm "scope"). */
  subjectRefs: string[];
  /** Evidence kèm value/unit để đối chiếu claim số (unit-aware). */
  evidence: EvidenceLite[];
  /** Sufficiency key CHƯA đạt baseline. Rỗng = baseline đạt. */
  insufficientKeys: string[];
  /** Team mapping availability từ packet (`available` | `partial` | `unavailable` | `ambiguous`). */
  teamAvailability: string;
  /** Ngày được phép nhắc tới (R2): period start/end, comparable start/end, series period_start/period_end. */
  allowedDates: string[];
}

function firstIssue(error: z.ZodError): ContractValidationError {
  const issue = error.issues[0];
  const path = issue?.path?.join(".") ?? "";
  const raw = issue?.message ?? "INVALID";
  const isUnknownKey = issue?.code === "unrecognized_keys" || /unrecognized key/i.test(raw);
  const code = isUnknownKey ? "UNKNOWN_FIELD" : issue?.code === "custom" ? raw : "SCHEMA_INVALID";
  return { ok: false, code, message: raw + (path ? " @ " + path : ""), path };
}

/** Mọi ISO date trong text phải nằm trong allowedDates (R2 — không bỏ qua date im lặng). */
function checkDates(text: string, allowedDates: Set<string>, at: string): ContractValidationError | null {
  for (const date of extractIsoDates(text)) {
    if (!allowedDates.has(date)) {
      return { ok: false, code: "UNGROUNDED_DATE_CLAIM", message: "ngày " + date + " không thuộc packet", path: at };
    }
  }
  return null;
}

/**
 * Claim số phải đối chiếu được evidence được trích dẫn (unit-aware R2, không dung sai, không cross-unit).
 * Date được validate trước, sau đó mới loại date khỏi numeric parsing.
 */
function checkGrounding(text: string, evidenceList: EvidenceLite[], allowedDates: Set<string>, at: string): ContractValidationError | null {
  const dateError = checkDates(text, allowedDates, at);
  if (dateError) return dateError;
  const claims = extractNumericClaims(text);
  if (claims.length === 0) return null;
  const sets = mergeGroundingSets(evidenceList);
  for (const claim of claims) {
    if (!isGroundedClaim(claim, sets)) {
      return { ok: false, code: "UNGROUNDED_NUMERIC_CLAIM", message: "số " + claim.token + " không khớp evidence được trích dẫn (unit-aware)", path: at };
    }
  }
  return null;
}

/**
 * Validate output analysis:
 * (1) nội dung bị cấm, (2) strict schema, (3) ràng buộc chéo với packet.
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
  const allowedDates = new Set(context.allowedDates);

  // Executive grounding: ref tồn tại + mọi claim số (executive + overall_limitations) phải ground.
  const execEvidence: EvidenceLite[] = [];
  for (const ref of report.executive_evidence_refs) {
    if (!evidenceIds.has(ref)) return fail("DANGLING_EVIDENCE_REF", "executive_evidence_refs không tồn tại: " + ref, "executive_evidence_refs");
    const ev = evidenceById.get(ref);
    if (ev) execEvidence.push(ev);
  }
  const execGrounding = checkGrounding(report.executive_analysis, execEvidence, allowedDates, "executive_analysis");
  if (execGrounding) return execGrounding;
  for (let i = 0; i < report.overall_limitations.length; i++) {
    const g = checkGrounding(report.overall_limitations[i], execEvidence, allowedDates, "overall_limitations[" + i + "]");
    if (g) return g;
  }

  // Không ép AI bịa finding: findings = [] hợp lệ nếu nêu rõ trạng thái giới hạn dữ liệu.
  if (report.findings.length === 0) {
    if (report.overall_limitations.length === 0) {
      return fail("EMPTY_FINDINGS_WITHOUT_LIMITATION", "findings rỗng thì overall_limitations phải có ít nhất một phần tử", "overall_limitations");
    }
    if (!LIMITATION_PHRASES.some((re) => re.test(report.executive_analysis))) {
      return fail("EMPTY_FINDINGS_WITHOUT_LIMITATION", "findings rỗng thì executive_analysis phải nêu trạng thái giới hạn dữ liệu", "executive_analysis");
    }
  }

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

    // Team chỉ optional: mapping partial thì finding team phải có limitation và không high confidence.
    if (TEAM_SUBJECT_REF_RE.test(finding.subject_ref) && context.teamAvailability !== "available") {
      if (finding.limitations.length === 0) {
        return fail("TEAM_FINDING_WITHOUT_COVERAGE_LIMITATION", "team mapping " + context.teamAvailability + " nên finding team phải nêu limitation coverage", at);
      }
      if (finding.confidence === "high") {
        return fail("TEAM_FINDING_WITHOUT_COVERAGE_LIMITATION", "team mapping " + context.teamAvailability + " nên finding team không được confidence high", at);
      }
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

    for (let li = 0; li < finding.limitations.length; li++) {
      const d = checkDates(finding.limitations[li], allowedDates, at + ".limitations[" + li + "]");
      if (d) return d;
    }

    const ground = finding.evidence_refs.map((ref) => evidenceById.get(ref)).filter((e) => e !== undefined);
    const g = checkGrounding([finding.headline, finding.analysis, finding.recommended_action ?? ""].join(" "), ground, allowedDates, at);
    if (g) return g;
  }

  return { ok: true, value: report };
}
