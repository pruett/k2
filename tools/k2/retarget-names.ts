/**
 * k2 retarget codemod: rename upstream kody production Cloudflare resource
 * names (Workers, D1, R2, queues, Vectorize, Workflows) to k2-* across every
 * tracked source, config and test file, so configs, the CI tools that read
 * them, and the tests that guard them stay consistent.
 *
 * Idempotent: k2-* names never match, so a second run changes nothing.
 * Usage: node tools/k2/retarget-names.ts [--check]   (runs oxfmt on changes)
 *   --check  exit 1 and list files when any upstream name remains.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'

const queues = [
	'email-delivery',
	'artifacts-repo-events',
	'platform-feedback-dispatch',
	'community-activity-dispatch',
	'community-listing-published-dispatch',
	'package-events-dispatch',
	'webhook-dispatch',
	'scheduled-dispatch',
]

const k2ResourceNames: Array<string> = [
	// Workers (and wrangler's `-production` env-suffixed script names)
	'production',
	'platform',
	'platform-production',
	'runtime',
	'runtime-production',
	'jobs',
	'jobs-production',
	'api',
	'api-production',
	'api-docs',
	'status',
	'nx-cache',
	'push-queue',
	'highlight',
	// Vite/miniflare test-env registrations (`<name>-test`) of jobs/highlight
	'jobs-test',
	'highlight-test',
	'production-d1-backups',
	// D1 (APP_DB `kody` is renamed in the wrangler configs by hand)
	'audit',
	// R2
	'community-assets',
	'email-blobs',
	'repo-session-blobs',
	'file-blobs',
	'operator-backups',
	'production-backups',
	// Vectorize, Workflows
	'capabilities-prod',
	'runtime-dynamic-callable-workflows',
	// Queues + DLQs
	...queues,
	...queues.map((q) => `${q}-dlq`),
]

// Paths left alone: prose, history, SQL migrations (checksummed), incident
// records, and the CLI/desktop clients (not deployed to Cloudflare).
const excluded = [
	/^docs\//,
	/\.md$/,
	/^\.agents\//,
	/^LICENSE$/,
	/^package-lock\.json$/,
	/^packages\/worker\/(audit-)?migrations\//,
	/^packages\/status\/retrospectives\//,
	/^packages\/cli\//,
	/^packages\/desktop\//,
	/^tools\/k2\//,
	// Reserved usernames merely share the names; not resource references.
	/^packages\/shared\/src\/reserved-usernames\.ts$/,
]

const alternation = [...k2ResourceNames]
	.sort((a, b) => b.length - a.length)
	.map((name) => name.replace(/[-]/g, '\\-'))
	.join('|')
// Not part of a longer identifier/name, not the API auth realm
// (`realm="kody-api"`), and not a source file name such as `kody-api.ts`.
const pattern = new RegExp(
	`(?<![A-Za-z0-9_@.-])(?<!realm=")kody-(${alternation})(?![A-Za-z0-9_-])(?!\\.(?:ts|tsx|js|mjs|cjs|json|md)\\b)`,
	'g',
)

// A line (or the line after a comment) marked `k2: keep upstream name` is left
// alone, e.g. a preview name derived from the upstream `kody` placeholder.
const keepMarker = 'k2: keep upstream name'

function retargetText(text: string) {
	const lines = text.split('\n')
	return lines
		.map((line, index) =>
			line.includes(keepMarker) || lines[index - 1]?.includes(keepMarker)
				? line
				: line.replace(pattern, (_match, name: string) => `k2-${name}`),
		)
		.join('\n')
}

function trackedFiles() {
	return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
		.split('\0')
		.filter(Boolean)
		.filter((path) => !excluded.some((re) => re.test(path)))
}

function main() {
	const check = process.argv.includes('--check')
	const changed: Array<string> = []
	for (const path of trackedFiles()) {
		let text: string
		try {
			text = readFileSync(path, 'utf8')
		} catch {
			continue
		}
		if (text.includes('\0')) continue
		const next = retargetText(text)
		if (next === text) continue
		changed.push(path)
		if (!check) writeFileSync(path, next)
	}
	// Shorter names can let oxfmt join lines; keep the repo formatted.
	if (!check && changed.length > 0) {
		execFileSync('npx', ['oxfmt', ...changed], { stdio: 'inherit' })
	}
	console.log(
		`${check ? 'would change' : 'changed'} ${changed.length} file(s)${changed.length ? ':\n  ' + changed.join('\n  ') : ''}`,
	)
	if (check && changed.length > 0) process.exit(1)
}

if (isExecutedDirectly(import.meta.url)) main()
