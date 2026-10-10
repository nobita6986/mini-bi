/**
 * P3.1-W02-B - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua dung mot doan trong migration #75 (append-only, da co
 * trong cay lam viec), chay lane focused `scripts/p3-1-w02b-vendor-lifecycle-db.test.mjs`
 * va BAT BUOC lane do phai DO. Sau moi lan, migration duoc khoi phuc byte-for-byte.
 *
 * Cach chay: node scripts/p3-1-w02b-vendor-lifecycle-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MIGRATION = path.resolve(
  "supabase/migrations/20261009110000_p3_1_w02b_vendor_lifecycle.sql",
);
const LANE = path.resolve("scripts/p3-1-w02b-vendor-lifecycle-db.test.mjs");

const CREATE_GUARD =
  "  -- Authorization first: an actor without catalog authority always gets 42501 and\n"
  + "  -- learns nothing about the shape of the input.\n"
  + "  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);";

const MUTATIONS = [
  {
    label: "1. bo kiem tra reserved namespace trong create",
    find: "  if v_vendor_id = '__system_vendor__' then\n"
      + "    raise exception 'vendor id is reserved' using errcode = '22023';\n"
      + "  end if;\n",
    replace: "",
  },
  {
    label: "2. create bo qua catalog operator guard",
    find: CREATE_GUARD,
    replace: "  v_authority := 'entry_admin';",
  },
  {
    label: "3. create khong tao representation recruiter",
    find: "  insert into public.recruiters (display_name, active, version)\n"
      + "  values (v_display, true, 1)\n"
      + "  returning recruiter_id into v_recruiter_id;",
    replace: "  v_recruiter_id := null;",
  },
  {
    label: "4. create ghi them team membership (vuot catalog boundary)",
    find: "  v_revision_id := public.direct_entry_write_vendor_revision(",
    replace: "  insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)\n"
      + "  values (v_recruiter_id, public.direct_entry_system_vendor_team_id(), p_valid_from);\n"
      + "  v_revision_id := public.direct_entry_write_vendor_revision(",
  },
  {
    label: "5. create ghi audit outcome DENIED",
    find: "     v_vendor.vendor_id, 'all', 'APPLIED', v_reason_id,\n"
      + "     array['vendor_id', 'display_name', 'active'], v_revision_id);",
    replace: "     v_vendor.vendor_id, 'all', 'DENIED', v_reason_id,\n"
      + "     array['vendor_id', 'display_name', 'active'], v_revision_id);",
  },
  {
    label: "6. snapshot vendor them key thu nam",
    find: "    'active', p_vendor.active,\n    'version', p_vendor.version\n  )\n$$;",
    replace: "    'active', p_vendor.active,\n    'version', p_vendor.version,\n"
      + "    'revision_count', 0\n  )\n$$;",
  },
  {
    label: "7. update tra ve active bi dao",
    find: "    'active', v_after.active,\n"
      + "    'version', v_vendor_version,\n"
      + "    'revision_id', v_revision_id,\n"
      + "    'recruiter_id', public.direct_entry_vendor_representation_recruiter(v_after.vendor_id)\n"
      + "  );\n"
      + "  perform public.direct_entry_idempotency_finish(\n"
      + "    p_app_user_id, 'vendor_update', p_idempotency_key, v_result\n"
      + "  );",
    replace: "    'active', not v_after.active,\n"
      + "    'version', v_vendor_version,\n"
      + "    'revision_id', v_revision_id,\n"
      + "    'recruiter_id', public.direct_entry_vendor_representation_recruiter(v_after.vendor_id)\n"
      + "  );\n"
      + "  perform public.direct_entry_idempotency_finish(\n"
      + "    p_app_user_id, 'vendor_update', p_idempotency_key, v_result\n"
      + "  );",
  },
];

const EXTRA_MUTATIONS = [
  {
    label: "8. set-active khong cho representation recruiter theo vendor",
    find: "  update public.recruiters r\n     set active = p_active,\n         version = r.version + 1",
    replace: "  update public.recruiters r\n     set active = r.active,\n         version = r.version",
  },
  {
    label: "9. bump version khong tang",
    find: "  update public.vendors\n     set version = version + 1\n"
      + "   where vendor_id = p_vendor_id\n  returning * into v_vendor;",
    replace: "  update public.vendors\n     set version = version\n"
      + "   where vendor_id = p_vendor_id\n  returning * into v_vendor;",
  },
  {
    label: "10. lock vendor bo kiem tra OCC",
    find: "  if v_vendor.version <> p_expected_version then\n"
      + "    raise exception 'vendor version conflict' using errcode = '40001';\n"
      + "  end if;\n",
    replace: "",
  },
  {
    label: "11. create bo idempotency replay",
    find: "  if v_prior is not null then\n    return v_prior;\n  end if;\n\n"
      + "  if exists (select 1 from public.vendors v where v.vendor_id = v_vendor_id) then",
    replace: "  if false then\n    return v_prior;\n  end if;\n\n"
      + "  if exists (select 1 from public.vendors v where v.vendor_id = v_vendor_id) then",
  },
  {
    label: "12. revision ghi sai version trong after snapshot",
    find: "    p_vendor_id, v_vendor.version, p_actor_user_id, p_reason_id,\n"
      + "    p_before_snapshot, public.direct_entry_vendor_snapshot(v_vendor)",
    replace: "    p_vendor_id, v_vendor.version, p_actor_user_id, p_reason_id,\n"
      + "    p_before_snapshot,"
      + " public.direct_entry_vendor_snapshot(v_vendor) || jsonb_build_object('version', 1)",
  },
  {
    label: "13. cap quyen execute create cho authenticated",
    find: "grant execute on function public.direct_entry_create_vendor"
      + "(uuid, uuid, integer, text, text, date, text, text)\n  to service_role;",
    replace: "grant execute on function public.direct_entry_create_vendor"
      + "(uuid, uuid, integer, text, text, date, text, text)\n  to service_role, authenticated;",
  },
];

MUTATIONS.push(...EXTRA_MUTATIONS);

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

const originalRaw = await readFile(MIGRATION, "utf8");
const originalHash = sha256(originalRaw);
// Anchors are written with LF; the ledger file itself is CRLF, so match on a
// normalized copy while the restore path always writes the untouched original.
const original = originalRaw.replace(/\r\n/g, "\n");
const results = [];
const start = Number(process.env.MUTATION_START ?? "0");

try {
  for (let index = start; index < MUTATIONS.length; index += 1) {
    const mutation = MUTATIONS[index];
    await writeFile(MIGRATION, applyMutation(original, mutation), "utf8");
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
    await writeFile(MIGRATION, originalRaw, "utf8");
  }
} finally {
  await writeFile(MIGRATION, originalRaw, "utf8");
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
