import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkReportMetricContract, validateWorkReportMetricContract } from "../../../lib/work-reports/metric-contract.ts";
import { validateWorkReportSchema } from "../../../lib/work-reports/schema-validator.ts";
import {
  allWorkReportFieldTypes, createWorkReportField, createWorkReportSection,
  canManageWorkReportTemplates, isWorkReportMetricFieldType, setWorkReportFieldMetric,
} from "../../../lib/work-reports/form-builder-model.ts";

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
