import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../../../lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract, validateWorkReportMetricContract } from "../../../lib/work-reports/metric-contract.ts";
import { validateWorkReportSchema } from "../../../lib/work-reports/schema-validator.ts";
import {
  allWorkReportFieldTypes, createWorkReportField, createWorkReportSection,
  canManageWorkReportTemplates, isWorkReportMetricFieldType, setWorkReportFieldMetric,
} from "../../../lib/work-reports/form-builder-model.ts";

const formBuilderPath = new URL("./form-builder.tsx", import.meta.url);

test("Form Builder creates valid defaults for each locked core field type", () => {
  for (const [index, type] of allWorkReportFieldTypes.entries()) {
    const field = createWorkReportField(type, "section_one", index + 1);
    const result = validateWorkReportSchema({ version: "work-report-schema/1.0", sections: [{
      section_key: "section_one", label: "Section", description: null, sort_order: 10, fields: [field],
    }] });
    assert.equal(result.ok, true, type);
    assert.equal(isWorkReportMetricFieldType(type), ["integer", "decimal", "boolean", "single_select", "multi_select"].includes(type));
  }
  assert.equal(createWorkReportSection(2).section_key, "section_2");
});

test("metric toggle permits only types supported by synchronous storage projection", () => {
  for (const type of ["integer", "decimal", "boolean", "single_select", "multi_select"]) {
    const enabled = setWorkReportFieldMetric(createWorkReportField(type, "section_one", 1), true);
    assert.equal(enabled.is_metric, true);
    const candidate = { version: "work-report-schema/1.0", sections: [{ section_key: "section_one",
      label: "Section", description: null, sort_order: 10, fields: [enabled] }] };
    assert.equal(validateWorkReportMetricContract(candidate, buildWorkReportMetricContract(candidate)).ok, true, type);
  }
  for (const type of ["text", "textarea", "date"]) {
    const field = createWorkReportField(type, "section_one", 1);
    assert.equal(setWorkReportFieldMetric(field, true).is_metric, false, type);
  }
});

test("page access requires the form-management capability at all scope", () => {
  assert.equal(canManageWorkReportTemplates(null), false);
  assert.equal(canManageWorkReportTemplates({ capabilities: ["report_form_manage"], scopes: [{ kind: "team" }] }), false);
  assert.equal(canManageWorkReportTemplates({ capabilities: ["report_assign"], scopes: [{ kind: "all" }] }), false);
  assert.equal(canManageWorkReportTemplates({ capabilities: ["report_form_manage"], scopes: [{ kind: "all" }] }), true);
});

test("Form Builder uses textarea ONLY for field labels, preserves newlines in preview, and keeps field_key/metric_key stable", async () => {
  const source = await readFile(formBuilderPath, "utf8");
  assert.match(source, /Nhãn<textarea aria-label="Nhãn trường"/);
  assert.match(source, /Tên mẫu<input/);
  assert.match(source, /<input aria-label="Tên nhóm"/);
  assert.match(source, /<input aria-label="Mô tả nhóm"/);
  assert.match(source, /Mô tả trường<input/);
  assert.match(source, /<span className="block whitespace-pre-line break-words font-medium">\{field\.label\}/);
  assert.doesNotMatch(source, /metric_key:\s*keyFromLabel/);

  const schema = structuredClone(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  schema.sections[0].fields[0].label = "Số cuộc gọi\n(trong ca trực)\nGồm gọi nhỡ cần gọi lại";
  const validated = validateWorkReportSchema(schema);
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.equal(validated.value.sections[0].fields[0].label, "Số cuộc gọi\n(trong ca trực)\nGồm gọi nhỡ cần gọi lại");
    assert.equal(validated.value.sections[0].fields[0].field_key, "calls_made");
    const contract = buildWorkReportMetricContract(validated.value);
    assert.equal(validateWorkReportMetricContract(validated.value, contract).ok, true);
    assert.equal(contract.metrics[0].metric_key, "calls_made");
    assert.equal(contract.metrics[0].compatible_group, "recruitment_daily_calls_made_v1");
  }

  const newlineOnly = structuredClone(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  newlineOnly.sections[0].fields[0].label = " \n\t\n ";
  assert.equal(validateWorkReportSchema(newlineOnly).ok, false);

  const overLengthWithNewline = structuredClone(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  overLengthWithNewline.sections[0].fields[0].label = "\n" + "a".repeat(256);
  assert.equal(validateWorkReportSchema(overLengthWithNewline).ok, false);
});
