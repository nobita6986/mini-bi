/**
 * P3.1-HF-R1 - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua dung mot doan trong migration #74 (append-only, da co trong
 * cay lam viec), chay lane focused `scripts/p3-1-hf-r1-duplicate-cccd-submit-confirmation-db.test.mjs`
 * va BAT BUOC lane do phai DO. Sau moi lan, migration duoc khoi phuc byte-for-byte.
 *
 * Cach chay: node scripts/p3-1-hf-r1-duplicate-cccd-submit-confirmation-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MIGRATION = path.resolve(
  "supabase/migrations/20261009100000_p3_1_hf_duplicate_cccd_reporting.sql",
);
const LANE = path.resolve("scripts/p3-1-hf-r1-duplicate-cccd-submit-confirmation-db.test.mjs");

const STATE_FN_CALL = "      v_state := public.direct_entry_submission_duplicate_cccd_state(p_submission_id);";
const PREFLIGHT_STATE_CALL = "    v_state := public.direct_entry_submission_duplicate_cccd_state(p_submission_id);";

const MUTATIONS = [
  {
    label: "1. predicate chi nhan ON",
    find: "       where c.latest_status in ('ON', 'UNCONFIRMED')",
    replace: "       where c.latest_status = 'ON'",
  },
  {
    label: "2. bo coalesce(..., 'UNCONFIRMED')",
    find: "                where st.entry_id = o.entry_id\n" +
      "                order by st.version desc\n" +
      "                limit 1\n" +
      "             ), 'UNCONFIRMED') as latest_status",
    replace: "                where st.entry_id = o.entry_id\n" +
      "                order by st.version desc\n" +
      "                limit 1\n" +
      "             ) as latest_status",
  },
  {
    label: "3. cho OFF vao canh bao",
    find: "       where c.latest_status in ('ON', 'UNCONFIRMED')",
    replace: "       where c.latest_status in ('ON', 'UNCONFIRMED', 'OFF')",
  },
  {
    label: "4. them dieu kien khac project",
    find: "       where public.direct_entry_is_canonical_national_id(d.cccd)",
    replace: "       where public.direct_entry_is_canonical_national_id(d.cccd)\n" +
      "         and exists (select 1 from public.direct_entries dr" +
      " where dr.entry_id = d.entry_id and dr.project_id <> o.project_id)",
  },
  {
    label: "5. bo loai self-match",
    find: "         and o.entry_id <> d.entry_id",
    replace: "         and true",
  },
  {
    label: "6. do trung ngay tren duong luu (save path)",
    find: "  -- 7e-1. The internal state helper:",
    replace: "  create or replace function public.direct_entry_hf_mutation_guard() returns trigger\n" +
      "  language plpgsql as $$ begin raise exception 'NATIONAL_ID_DUPLICATE'; end; $$;\n" +
      "  create trigger direct_entry_hf_mutation before insert on public.direct_entries\n" +
      "    for each row execute function public.direct_entry_hf_mutation_guard();\n\n" +
      "  -- 7e-1. The internal state helper:",
  },
  {
    label: "7. bo kiem tra phia server (chi con client)",
    find: "          raise exception 'duplicate cccd acknowledgement required' using errcode = '22023';",
    replace: "          null;",
  },
  {
    label: "8. bo server recheck khi confirm",
    find: STATE_FN_CALL,
    replace: "      v_state := jsonb_build_object('conflict_count', 1," +
      " 'fingerprint', p_ack_fingerprint);",
  },
  {
    label: "9. cho boolean/fingerprint gia bypass",
    find: "        if p_ack_fingerprint is null\n" +
      "           or p_ack_fingerprint <> (v_state->>'fingerprint')\n" +
      "           or p_ack_conflict_count is null\n" +
      "           or p_ack_conflict_count <> v_conflict_count then",
    replace: "        if p_ack_fingerprint is null\n" +
      "           or p_ack_conflict_count is null\n" +
      "           or p_ack_conflict_count <> v_conflict_count then",
  },
  {
    label: "10. giu chu ky legacy co the bypass",
    find: "  begin\n" +
      "    return public.direct_entry_transition_submission_apply(\n" +
      "      p_auth_subject, p_app_user_id, p_submission_id, p_expected_version,\n" +
      "      p_target_state, p_idempotency_key, null, null\n" +
      "    );\n" +
      "  end;",
    replace: "  declare\n" +
      "    v_mutation_result jsonb;\n" +
      "  begin\n" +
      "    update public.direct_entry_submissions set state = p_target_state,\n" +
      "      version = version + 1 where submission_id = p_submission_id;\n" +
      "    v_mutation_result := jsonb_build_object('submission_id', p_submission_id,\n" +
      "      'state', p_target_state, 'version', p_expected_version + 1);\n" +
      "    return v_mutation_result;\n" +
      "  end;",
  },
  {
    label: "11. lo CCCD day du trong projection",
    find: "                 'cccd_last4', i.cccd_last4",
    replace: "                 'cccd_last4', i.other_cccd",
  },
  {
    label: "12. ghi audit APPLIED o preflight",
    find: "  language plpgsql\n" +
      "  stable\n" +
      "  security definer\n" +
      "  set search_path = pg_catalog, public\n" +
      "  as $preflight$",
    replace: "  language plpgsql\n" +
      "  volatile\n" +
      "  security definer\n" +
      "  set search_path = pg_catalog, public\n" +
      "  as $preflight$",
  },
  {
    label: "13. bo idempotency replay (double confirm)",
    find: "    if v_prior_result is not null then return v_prior_result; end if;",
    replace: "    if false then return v_prior_result; end if;",
  },
];

const EXTRA_MUTATION_12_INSERT = {
  find: PREFLIGHT_STATE_CALL + "\n    return jsonb_build_object(",
  replace: PREFLIGHT_STATE_CALL + "\n" +
    "    insert into public.direct_entry_audit_events\n" +
    "      (auth_subject, app_user_id, action, outcome, changed_fields)\n" +
    "    values (p_auth_subject, p_app_user_id, 'submission_transition', 'APPLIED',\n" +
    "      array['duplicate_cccd_preflight']);\n" +
    "    return jsonb_build_object(",
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function applyMutation(source, mutation) {
  const parts = source.split(mutation.find);
  if (parts.length !== 2) {
    throw new Error(
      "anchor must occur exactly once for " + mutation.label + " (found " + (parts.length - 1) + ")",
    );
  }
  return parts.join(mutation.replace);
}

const original = await readFile(MIGRATION, "utf8");
const originalHash = sha256(original);
const results = [];
const start = Number(process.env.MUTATION_START ?? "0");

try {
  for (let index = start; index < MUTATIONS.length; index += 1) {
    const mutation = MUTATIONS[index];
    let mutated = applyMutation(original, mutation);
    if (index === 11) {
      // Mutation 12 can them buoc ghi audit trong preflight sau khi da doi stable -> volatile.
      mutated = applyMutation(mutated, EXTRA_MUTATION_12_INSERT);
    }
    await writeFile(MIGRATION, mutated, "utf8");
    let exitCode = 0;
    try {
      await run(process.execPath, ["--test", LANE], {
        cwd: path.resolve("."),
        maxBuffer: 128 * 1024 * 1024,
      });
    } catch (error) {
      exitCode = typeof error.code === "number" ? error.code : 1;
    }
    const red = exitCode !== 0;
    results.push({ label: mutation.label, red, exitCode });
    console.log((red ? "RED   " : "GREEN ") + mutation.label + " (exit " + exitCode + ")");
    await writeFile(MIGRATION, original, "utf8");
  }
} finally {
  await writeFile(MIGRATION, original, "utf8");
}

const restoredHash = sha256(await readFile(MIGRATION, "utf8"));
const green = results.filter((item) => !item.red);
console.log("");
console.log("mutation checks red: " + (results.length - green.length) + "/" + results.length);
console.log("migration restored byte-for-byte: " + String(restoredHash === originalHash));
if (green.length > 0 || restoredHash !== originalHash) {
  console.error("MUTATION EVIDENCE FAILED " + JSON.stringify(green));
  process.exitCode = 1;
}

