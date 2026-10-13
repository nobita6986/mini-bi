#!/usr/bin/env bash
set -Eeuo pipefail

readonly COMPOSE_FILE=/opt/bi/compose.yaml
readonly RELEASE_FILE=/opt/bi/.release.env
readonly LOCK_FILE=/opt/bi/.deploy.lock
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

printf 'BI_IMAGE=%s\n' "$resolved_image" >"$RELEASE_FILE.new"
chmod 640 "$RELEASE_FILE.new"
mv "$RELEASE_FILE.new" "$RELEASE_FILE"

docker compose --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" config --quiet
docker compose --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" up -d --wait --remove-orphans

echo "BI deployment is healthy: $resolved_image"
trap - EXIT
