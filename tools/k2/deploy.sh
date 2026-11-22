#!/usr/bin/env bash
# k2 local production deploy: replays .github/workflows/deploy.yml (and
# nx-cache-deploy.yml) job by job from this checkout, against the account in
# ~/.config/k2/cloudflare.env, with Worker secrets from ~/.config/k2/k2-secrets.env.
# No secret value is written to the repo or printed.
#
# Usage: tools/k2/deploy.sh [step ...]
#   steps (default: all, in deploy.yml order):
#     highlight push-queue jobs origin status api api-docs nx-cache health
#
# Every step is safe to rerun: resource ensures are idempotent, secret sync is
# a bulk upsert, and wrangler deploys converge to the checked-out commit.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# --- k2 configuration (non-secret; the one place deploy-time values live) ---
export APP_BASE_URL=https://k2.pruett.in
export K2_ZONE_NAME=pruett.in
# k2 switch: skip the dmarc@ forward rule (TXT records are still ensured).
export DMARC_REPORT_FORWARD_TO=off
K2_HOSTS=(k2-status.pruett.in k2-api.pruett.in k2-api-docs.pruett.in k2-nx-cache.pruett.in)

set -a
# shellcheck disable=SC1090,SC1091
. "$HOME/.config/k2/cloudflare.env"
# shellcheck disable=SC1090,SC1091
. "$HOME/.config/k2/k2-secrets.env"
set +a
# The PEM is stored on one line with \n escapes.
OIDC_SIGNING_PRIVATE_KEY_PEM="$(printf '%b' "$OIDC_SIGNING_PRIVATE_KEY_PEM")"
export OIDC_SIGNING_PRIVATE_KEY_PEM

cf_api() {
	curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4$1"
}
CLOUDFLARE_ZONE_ID="$(cf_api "/zones?name=$K2_ZONE_NAME" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result[0].id))')"
export CLOUDFLARE_ZONE_ID
WORKERS_DEV_SUBDOMAIN="$(cf_api "/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result.subdomain))')"
DEPLOY_COMMIT_SHA="$(git rev-parse HEAD)"
export DEPLOY_COMMIT_SHA
STATE_DIR=.tmp/k2-deploy
mkdir -p "$STATE_DIR"

log() { printf '\n=== %s\n' "$*" >&2; }

# Run a command up to 3 times (deploy.yml retries the same way).
retry() {
	local attempt
	for attempt in 1 2 3; do
		if "$@"; then return 0; fi
		[ "$attempt" = 3 ] && return 1
		log "retrying in $((attempt * 10))s: $1"
		sleep $((attempt * 10))
	done
}

# key=value lines a tools/ci script printed for $GITHUB_OUTPUT.
# output_of: a required key; missing is fatal.
output_of() {
	local value
	if ! value="$(optional_output_of "$1" "$2")" || [ -z "$value" ]; then
		echo "missing required output $2 in $1" >&2
		return 1
	fi
	printf '%s\n' "$value"
}
# optional_output_of: empty when the key is absent (e.g. bootstrap configs
# exist only on a fresh account).
optional_output_of() {
	{ grep -E "^$2=" "$1" || true; } | tail -1 | cut -d= -f2-
}

# Same predicates as deploy.yml: JSON with the endpoint's health flag
# (`ok: true`, or `status: "ok"` plus `cookieSecretConfigured: true` for
# platform/runtime) and an exact commit
# match in its commit field (`commit` or `commitSha`). Retries, then fails.
healthcheck() {
	local url="$1" flag="$2" commit_field="$3" body
	for _ in $(seq 1 12); do
		if body="$(curl -fsS --max-time 15 -H 'Accept: application/json' "$url")" &&
			printf '%s' "$body" | EXPECTED="$DEPLOY_COMMIT_SHA" FLAG="$flag" FIELD="$commit_field" node -e '
				let s = ""
				process.stdin.on("data", (d) => (s += d)).on("end", () => {
					let json
					try { json = JSON.parse(s) } catch { console.error("not JSON"); process.exit(1) }
					const healthy = process.env.FLAG === "status" ? json?.status === "ok" && json?.cookieSecretConfigured === true : json?.ok === true
					const commit = json?.[process.env.FIELD]
					if (!healthy || commit !== process.env.EXPECTED) {
						console.error("unhealthy or stale", { healthy, commit, expected: process.env.EXPECTED })
						process.exit(1)
					}
				})'; then
			echo "OK $url (commit $DEPLOY_COMMIT_SHA)"
			return 0
		fi
		sleep 5
	done
	echo "FAIL $url" >&2
	return 1
}

step_highlight() {
	log "highlight worker"
	retry node ./wrangler-env.ts deploy --config packages/highlight-worker/wrangler.jsonc \
		--name k2-highlight --env production --var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
}

step_push_queue() {
	log "push queue worker"
	retry node ./wrangler-env.ts deploy --config packages/push-queue-worker/wrangler.jsonc \
		--name k2-push-queue --env production --var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
}

step_jobs() {
	log "jobs worker: ensure D1 + queues"
	node tools/ci/jobs-worker-resources.ts ensure --env production \
		--out-config packages/jobs-worker/wrangler-production.generated.json | tee "$STATE_DIR/jobs.out"
	local config bootstrap mode
	config="$(output_of "$STATE_DIR/jobs.out" jobs_wrangler_config)"
	bootstrap="$(optional_output_of "$STATE_DIR/jobs.out" jobs_wrangler_bootstrap_config)"
	mode="$(output_of "$STATE_DIR/jobs.out" jobs_deploy_mode)"
	echo "$mode" > "$STATE_DIR/jobs-mode"
	node ./wrangler-env.ts d1 migrations apply JOBS_DB --remote --config "$config"
	# Fresh account: no origin script yet, so deploy without HOST and
	# redeploy with it after origin (step_origin).
	retry node ./wrangler-env.ts deploy --config "${bootstrap:-$config}" \
		--name k2-jobs --var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
}

origin_secret_flags=(
	--set-from-env COOKIE_SECRET --set-from-env SECRET_STORE_KEY
	--set-from-env CLOUDFLARE_API_TOKEN=CLOUDFLARE_APP_API_TOKEN
	--set-from-env OIDC_SIGNING_PRIVATE_KEY_PEM --set-from-env OIDC_SIGNING_KEY_ID
	--set-from-env TURNSTILE_SITE_KEY --set-from-env TURNSTILE_SECRET_KEY
)

runtime_owns_classes() {
	cf_api "/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/durable_objects/namespaces?per_page=1000" |
		node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).result.some(n=>n.script==="k2-runtime"&&n.class==="StorageRunner")?0:1))'
}

step_origin() {
	[ -f packages/worker/.env ] || cp packages/worker/.env.example packages/worker/.env
	log "origin: ensure production resources"
	node tools/ci/production-resources.ts ensure \
		--out-config packages/worker/wrangler-production.generated.json --resource-title-base k2 | tee "$STATE_DIR/origin.out"
	local config mode bootstrap
	config="$(output_of "$STATE_DIR/origin.out" wrangler_config)"
	mode="$(output_of "$STATE_DIR/origin.out" origin_deploy_mode)"
	bootstrap="$(optional_output_of "$STATE_DIR/origin.out" origin_bootstrap_wrangler_config)"
	echo "origin_deploy_mode=$mode"

	log "generate runtime + platform configs"
	node tools/ci/runtime-worker-config.ts generate --env production \
		--main-config packages/worker/wrangler-production.generated.json \
		--worker-name k2-runtime --platform-worker-name k2-platform --main-worker-name k2-production \
		--out-config packages/runtime-worker/wrangler-production.generated.json
	node tools/ci/platform-worker-config.ts generate --env production \
		--main-config packages/worker/wrangler-production.generated.json \
		--worker-name k2-platform --runtime-worker-name k2-runtime --main-worker-name k2-production \
		--out-config packages/platform-worker/wrangler-production.generated.json \
		--out-platform-bootstrap-config packages/platform-worker/wrangler-production-bootstrap.generated.json

	log "secrets: origin, runtime, platform"
	# --env "" with --name: secret bulk suffixes -<env> onto the config's base
	# name (kody), which would write to a kody-production script.
	node tools/ci/sync-worker-secrets.ts --env "" --name k2-production --config "$config" "${origin_secret_flags[@]}"
	node tools/ci/sync-worker-secrets.ts --env "" --name k2-runtime \
		--config packages/runtime-worker/wrangler-production.generated.json \
		--set-from-env COOKIE_SECRET --set-from-env SECRET_STORE_KEY \
		--set-from-env CLOUDFLARE_API_TOKEN=CLOUDFLARE_RUNTIME_API_TOKEN
	local platform_mode=()
	[ "$mode" = fresh ] || platform_mode=(--versioned)
	node tools/ci/sync-worker-secrets.ts "${platform_mode[@]}" --env "" --name k2-platform \
		--config packages/platform-worker/wrangler-production.generated.json "${origin_secret_flags[@]}"

	log "D1 migrations"
	node ./wrangler-env.ts d1 migrations apply APP_DB --remote --config "$config"
	node ./wrangler-env.ts d1 migrations apply AUDIT_DB --remote --config "$config"

	if [ "$mode" = fresh ]; then
		log "bootstrap fresh origin (full entry)"
		CLOUDFLARE_ENV=production retry npm run deploy -- --name k2-production --config "$bootstrap" \
			--var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
	fi
	# Platform and runtime bind each other's Durable Objects; Cloudflare rejects
	# a binding to a class the runtime script does not export yet (10061). Until
	# k2-runtime owns StorageRunner, upload platform without runtime references
	# first (preview.yml does the same), then runtime, then the full platform.
	if ! runtime_owns_classes; then
		log "platform worker bootstrap (no runtime references)"
		retry npm run deploy -- --name k2-platform \
			--config packages/platform-worker/wrangler-production-bootstrap.generated.json \
			--var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
		log "runtime worker"
		retry npm run deploy -- --name k2-runtime \
			--config packages/runtime-worker/wrangler-production.generated.json \
			--var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
	fi
	log "platform worker"
	retry npm run deploy -- --name k2-platform \
		--config packages/platform-worker/wrangler-production.generated.json \
		--var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
	log "runtime worker"
	retry npm run deploy -- --name k2-runtime \
		--config packages/runtime-worker/wrangler-production.generated.json \
		--var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
	log "origin worker"
	local deploy_info
	deploy_info="$(node tools/ci/build-deploy-info.ts)"
	CLOUDFLARE_ENV=production retry npm run deploy -- --name k2-production --config "$config" \
		--var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA" --var "APP_DEPLOY_INFO:$deploy_info"

	if [ "$(cat "$STATE_DIR/jobs-mode" 2>/dev/null)" = fresh ]; then
		log "redeploy jobs worker with HOST (fresh account)"
		node tools/ci/jobs-worker-resources.ts ensure --env production \
			--out-config packages/jobs-worker/wrangler-production.generated.json
		retry node ./wrangler-env.ts deploy --config packages/jobs-worker/wrangler-production.generated.json \
			--name k2-jobs --var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
		echo steady > "$STATE_DIR/jobs-mode"
	fi
}

step_status() {
	log "status worker"
	# The account id is not committed in packages/status/wrangler.jsonc.
	retry npm run status:deploy -- --var "BUILD_COMMIT:$DEPLOY_COMMIT_SHA" \
		--var "CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID"
	printf '%s' "$CLOUDFLARE_STATUS_API_TOKEN" |
		npx wrangler secret put CLOUDFLARE_API_TOKEN --config packages/status/wrangler.jsonc
}

step_api() {
	log "api worker"
	retry node ./wrangler-env.ts deploy --config packages/api-worker/wrangler.jsonc \
		--name k2-api --env production --var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
}

step_api_docs() {
	log "api docs worker"
	retry node ./wrangler-env.ts deploy --config packages/api-docs-worker/wrangler.jsonc \
		--name k2-api-docs --var "APP_COMMIT_SHA:$DEPLOY_COMMIT_SHA"
}

step_nx_cache() {
	log "nx cache worker"
	node tools/ci/nx-cache-resources.ts
	retry npm run nx-cache:deploy -- --var "BUILD_COMMIT:$DEPLOY_COMMIT_SHA"
	node tools/ci/sync-worker-secrets.ts --env "" --config packages/nx-cache/wrangler.jsonc \
		--name k2-nx-cache --set-from-env CACHE_ACCESS_TOKEN
}

step_health() {
	log "healthchecks"
	local fail=0 host dev="$WORKERS_DEV_SUBDOMAIN.workers.dev"
	healthcheck "$APP_BASE_URL/health" ok commitSha || fail=1
	healthcheck "https://k2-platform.$dev/__platform/health" status commitSha || fail=1
	healthcheck "https://k2-runtime.$dev/__runtime/health" status commitSha || fail=1
	for host in k2-jobs k2-highlight k2-push-queue; do
		healthcheck "https://$host.$dev/health" ok commit || fail=1
	done
	for host in "${K2_HOSTS[@]}"; do
		healthcheck "https://$host/health" ok commit || fail=1
	done
	return "$fail"
}

steps=("$@")
[ "${#steps[@]}" -gt 0 ] || steps=(highlight push-queue jobs origin status api api-docs nx-cache health)
for s in "${steps[@]}"; do
	"step_${s//-/_}"
done
