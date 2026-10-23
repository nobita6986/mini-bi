#!/usr/bin/env bash
set -Eeuo pipefail

readonly COMPOSE_FILE=/opt/bi/compose.yaml
readonly RELEASE_FILE=/opt/bi/.release.env
readonly LOCK_FILE=/opt/bi/.deploy.lock
readonly RUNTIME_ENV=/etc/bi/production.env
if [[ $# -ne 1 || ! $1 =~ ^ghcr\.io/nobita6986/mini-bi:[0-9a-f]{40}(-vps2)?$ ]]; then
  echo "refusing unexpected or non-immutable BI image reference" >&2
  exit 65
fi

requested_image=$1
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another BI deployment is already running" >&2; exit 75; }

previous_image=
if [[ -f $RELEASE_FILE ]]; then
  previous_image=$(sed -n 's/^BI_IMAGE=//p' "$RELEASE_FILE" | head -n 1)
fi

rollback() {
  if [[ -n $previous_image ]]; then
    printf 'BI_IMAGE=%s\n' "$previous_image" >"$RELEASE_FILE"
    docker compose --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" up -d --wait || true
  fi
}
trap 'rc=$?; if [[ $rc -ne 0 ]]; then rollback; fi; exit $rc' EXIT

resolved_image=$(docker image inspect --format '{{index .RepoDigests 0}}' "$requested_image")
if [[ ! $resolved_image =~ ^ghcr\.io/nobita6986/mini-bi@sha256:[0-9a-f]{64}$ ]]; then
  echo "unable to resolve an immutable GHCR digest" >&2
  exit 66
fi

[[ -r $RUNTIME_ENV ]] || { echo "missing root-owned $RUNTIME_ENV" >&2; exit 66; }
[[ $(stat -c '%U:%G:%a' "$RUNTIME_ENV") == root:root:600 ]] || {
  echo "$RUNTIME_ENV must be root:root mode 0600" >&2
  exit 66
}
for name in \
  DIRECT_ENTRY_API_ENABLED DIRECT_ENTRY_UI_ENABLED WORK_REPORTS_API_ENABLED \
  ATTENDANCE_ENABLED ATTENDANCE_TIME_TOKEN_SECRET DOCUMENT_STORAGE_ENVIRONMENT \
  R2_ACCOUNT_ID R2_BUCKET_NAME R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  [[ $(grep -c "^${name}=" "$RUNTIME_ENV" || true) -eq 1 ]] || {
    echo "$RUNTIME_ENV must contain exactly one $name entry" >&2
    exit 66
  }
done

# Validate secrets inside the candidate image without printing their values.
docker run --rm -i --network none --env-file "$RUNTIME_ENV" \
  --entrypoint node "$resolved_image" - <<'NODE'
const fail = (message) => {
  console.error(`runtime environment invalid: ${message}`);
  process.exit(1);
};

for (const name of [
  "DIRECT_ENTRY_API_ENABLED",
  "DIRECT_ENTRY_UI_ENABLED",
  "WORK_REPORTS_API_ENABLED",
  "ATTENDANCE_ENABLED",
]) {
  if (process.env[name] !== "true") fail(`${name} must equal true`);
}
if (process.env.DOCUMENT_STORAGE_ENVIRONMENT !== "production") {
  fail("DOCUMENT_STORAGE_ENVIRONMENT must equal production");
}
for (const name of ["R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
  if (!process.env[name]?.trim()) fail(`${name} is required`);
}
if (process.env.R2_BUCKET_NAME !== "hrp-bi-product") {
  fail("R2_BUCKET_NAME must equal hrp-bi-product");
}

const raw = process.env.ATTENDANCE_TIME_TOKEN_SECRET;
if (typeof raw !== "string") fail("ATTENDANCE_TIME_TOKEN_SECRET is required");
const secret = raw.trim();
const placeholders = new Set([
  "<attendance-time-token-secret>",
  "attendance-time-token-secret",
  "changeme",
  "placeholder",
  "secret",
  "default",
]);
if (
  secret.length < 32 ||
  secret.length > 512 ||
  !/^[\x21-\x7e]+$/.test(secret) ||
  new Set(secret).size < 8 ||
  placeholders.has(secret.toLowerCase()) ||
  (secret.startsWith("<") && secret.endsWith(">"))
) {
  fail("ATTENDANCE_TIME_TOKEN_SECRET does not meet the runtime contract");
}

const disallowed = new Set();
for (const name of [
  "SUPABASE_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_DB_URL",
  "R2_SECRET_ACCESS_KEY",
  "R2_ACCESS_KEY_ID",
  "AI_WORKER_TOKEN",
  "AI_CONFIG_MASTER_KEY",
]) {
  const value = process.env[name]?.trim();
  if (!value) continue;
  disallowed.add(value);
  if (name === "SUPABASE_DB_URL") {
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password) disallowed.add(password);
    } catch {}
  }
}
for (const [name, value] of Object.entries(process.env)) {
  if (name === "ATTENDANCE_TIME_TOKEN_SECRET" || !value?.trim()) continue;
  if (
    name.endsWith("_SECRET") ||
    name.endsWith("_SECRET_KEY") ||
    name.endsWith("_TOKEN") ||
    name.endsWith("_MASTER_KEY")
  ) {
    disallowed.add(value.trim());
  }
}
if (disallowed.has(secret)) fail("ATTENDANCE_TIME_TOKEN_SECRET reuses another credential");
console.log("runtime environment preflight passed");
NODE

printf 'BI_IMAGE=%s\n' "$resolved_image" >"$RELEASE_FILE.new"
chmod 640 "$RELEASE_FILE.new"
mv "$RELEASE_FILE.new" "$RELEASE_FILE"

docker compose --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" config --quiet
docker compose --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" up -d --wait --remove-orphans

docker compose --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" exec -T app \
  node --input-type=module - <<'NODE'
const checks = [
  ["/api/attendance/time", undefined, 401, "UNAUTHENTICATED"],
  ["/api/attendance/check-in", { method: "POST" }, 403, "CSRF_REJECTED"],
];
for (const [path, init, expectedStatus, expectedCode] of checks) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, init);
  const body = await response.json().catch(() => null);
  if (response.status !== expectedStatus || body?.code !== expectedCode) {
    throw new Error(`attendance post-deploy check failed for ${path}`);
  }
}
console.log("attendance post-deploy checks passed");
NODE

echo "BI deployment is healthy: $resolved_image"
trap - EXIT
