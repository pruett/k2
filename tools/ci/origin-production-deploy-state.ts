import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cloudflareApiRequest } from './resource-utils.ts'
import { defaultDevEntryPath } from '../check-origin-production-exports.ts'

export const productionOriginScriptName = 'k2-production'
export const productionPlatformScriptName = 'k2-platform'
export const productionRuntimeScriptName = 'k2-runtime'

export const platformOwnedClassNames = [
	'MCP',
	'McpClientHub',
	'OAuthPurgeCoordinator',
	'UserMeter',
	'Mailbox',
	'RepoSession',
	'RepoSessionIndex',
	'StripePlanRefresh',
] as const

export const runtimeOwnedClassNames = [
	'StorageRunner',
	'RunLog',
	'PackageRealtimeSession',
] as const

export const productionOriginBootstrapWorkflowName = `${productionOriginScriptName}-bootstrap-dynamic-callable-workflows`

const transferredClassNames = [
	...platformOwnedClassNames,
	...runtimeOwnedClassNames,
] as const

/**
 * The three scripts one origin/platform/runtime fleet is made of. Production
 * uses the fixed names above; preview substitutes the per-PR names
 * (`kody-pr-<n>`, `kody-pr-<n>-platform`, `kody-pr-<n>-runtime`).
 */
export type OriginFleetScriptNames = {
	origin: string
	platform: string
	runtime: string
}

const productionFleetScriptNames: OriginFleetScriptNames = {
	origin: productionOriginScriptName,
	platform: productionPlatformScriptName,
	runtime: productionRuntimeScriptName,
}

export function previewFleetScriptNames(
	originWorkerName: string,
): OriginFleetScriptNames {
	return {
		origin: originWorkerName,
		platform: `${originWorkerName}-platform`,
		runtime: `${originWorkerName}-runtime`,
	}
}

type OriginProductionDeployMode = 'fresh' | 'steady' | 'ambiguous'

export type DurableObjectNamespaceOwnership = {
	script: string
	className: string
}

export type OriginProductionScriptState = {
	mode: OriginProductionDeployMode
	reason: string
	originOwnedTransferredClassNames: ReadonlyArray<string>
	/**
	 * k2-runtime does not own its classes yet, so the platform must first be
	 * uploaded without runtime references, then runtime (Cloudflare 10061
	 * otherwise). The one decision deploy.yml and tools/k2/deploy.sh share.
	 */
	platformRuntimeBootstrap: boolean
	/**
	 * A first deploy interrupted after the platform bootstrap: platform owns
	 * all its classes, origin still owns every runtime class, runtime owns
	 * none. The bootstrap completes the transfer in the same run, so origin
	 * can upload the slim entry instead of replaying its bootstrap.
	 */
	resumesRuntimeTransfer: boolean
}

export type OriginProductionDeployPlan = {
	mode: OriginProductionDeployMode
	originEntry: 'full' | 'slim'
	runOriginBootstrap: boolean
	forcePlatformAndRuntime: boolean
	platformRuntimeBootstrap: boolean
	reason: string
}

export function isCloudflareNotFoundError(error: unknown) {
	if (!(error instanceof Error)) return false
	return /Cloudflare API request failed \(404\)/.test(error.message)
}

/**
 * GET /workers/scripts/:name returns the Worker upload as multipart, not
 * the JSON envelope `cloudflareApiRequest` expects. HTTP 200 still means
 * the script exists.
 */
export function isCloudflareOkNonJsonError(error: unknown) {
	if (!(error instanceof Error)) return false
	return /Malformed Cloudflare response \(200\)/.test(error.message)
}

export function planOriginProductionDeploy(
	state: OriginProductionScriptState,
): OriginProductionDeployPlan {
	if (state.mode === 'fresh') {
		return {
			mode: 'fresh',
			originEntry: 'slim',
			runOriginBootstrap: true,
			forcePlatformAndRuntime: true,
			platformRuntimeBootstrap: state.platformRuntimeBootstrap,
			reason: state.reason,
		}
	}
	if (state.mode === 'steady') {
		return {
			mode: 'steady',
			originEntry: 'slim',
			runOriginBootstrap: false,
			forcePlatformAndRuntime: false,
			platformRuntimeBootstrap: false,
			reason: state.reason,
		}
	}
	return {
		mode: 'ambiguous',
		originEntry: state.resumesRuntimeTransfer ? 'slim' : 'full',
		runOriginBootstrap: false,
		forcePlatformAndRuntime: state.platformRuntimeBootstrap,
		platformRuntimeBootstrap: state.platformRuntimeBootstrap,
		reason: state.resumesRuntimeTransfer
			? `${state.reason} Platform owns its classes and origin still owns every runtime class: resume with platform bootstrap, runtime, then the slim origin.`
			: state.reason,
	}
}

export type OriginPreviewDeployPlan = {
	mode: OriginProductionDeployMode
	originEntry: 'full' | 'slim'
	reason: string
}

/**
 * Preview variant of `planOriginProductionDeploy`. A preview fleet is created
 * fresh per PR and its platform/runtime scripts create their own classes with
 * `new_sqlite_classes`, so there is never storage to transfer off the origin
 * script: a preview origin never bootstraps, and uploads the same slim entry
 * steady-state production does.
 *
 * Unlike production, `ambiguous` does not force the full entry. A retried
 * preview run (platform/runtime already deployed, origin not yet) classifies
 * as ambiguous, and the origin's bindings are cross-script in every mode, so
 * the slim entry is always the correct upload. The one thing Cloudflare
 * rejects (error 10064) is a slim upload to a script that still owns a
 * Durable Object class, so the full entry stays only as the fallback for a
 * preview origin created before the slim topology that still owns
 * transferred classes.
 */
export function planOriginPreviewDeploy(
	state: OriginProductionScriptState,
): OriginPreviewDeployPlan {
	if (state.originOwnedTransferredClassNames.length > 0) {
		return {
			mode: state.mode,
			originEntry: 'full',
			reason: `Origin still owns ${state.originOwnedTransferredClassNames.join(', ')}; a slim upload would be rejected. ${state.reason}`,
		}
	}
	return { mode: state.mode, originEntry: 'slim', reason: state.reason }
}

function classesOnScript(
	namespaces: ReadonlyArray<DurableObjectNamespaceOwnership>,
	script: string,
) {
	return new Set(
		namespaces
			.filter((entry) => entry.script === script)
			.map((entry) => entry.className),
	)
}

function everyClassOnScript(
	namespaces: ReadonlyArray<DurableObjectNamespaceOwnership>,
	script: string,
	classNames: ReadonlyArray<string>,
) {
	const owned = classesOnScript(namespaces, script)
	return classNames.every((className) => owned.has(className))
}

function anyTransferredClassOnScript(
	namespaces: ReadonlyArray<DurableObjectNamespaceOwnership>,
	script: string,
) {
	const owned = classesOnScript(namespaces, script)
	return transferredClassNames.some((className) => owned.has(className))
}

function transferredClassesOnScript(
	namespaces: ReadonlyArray<DurableObjectNamespaceOwnership>,
	script: string,
) {
	const owned = classesOnScript(namespaces, script)
	return transferredClassNames.filter((className) => owned.has(className))
}

function scriptState(
	mode: OriginProductionDeployMode,
	reason: string,
	originOwnedTransferredClassNames: ReadonlyArray<string> = [],
): OriginProductionScriptState {
	return {
		mode,
		reason,
		originOwnedTransferredClassNames,
		platformRuntimeBootstrap: false,
		resumesRuntimeTransfer: false,
	}
}

/**
 * Fail-closed classification of the live production origin script.
 *
 * `null` means the probe failed or was skipped (dry-run). That is never
 * treated as fresh or steady — both of those require positive evidence.
 */
type OriginFleetProbe = {
	originScriptExists: boolean | null
	platformScriptExists?: boolean | null
	runtimeScriptExists?: boolean | null
	namespaces: ReadonlyArray<DurableObjectNamespaceOwnership> | null
	scriptNames?: OriginFleetScriptNames
}

export function classifyOriginProductionScriptState(
	input: OriginFleetProbe,
): OriginProductionScriptState {
	const ownership = classifyOriginOwnership(input)
	return {
		...ownership,
		...classifyPlatformRuntimeBootstrap(input, ownership.mode),
	}
}

/**
 * The platform/runtime bootstrap runs only on a fresh fleet (origin bootstrap
 * creates the classes first) or in the one resumable interruption: platform
 * owns every platform class, origin still owns every runtime class, runtime
 * owns none. There the bootstrap completes the transfer and origin uploads the
 * slim entry, so the origin config generated before the run stays correct.
 * Any other mixed ownership (for example a partially transferred platform,
 * which an interrupted run cannot produce because the platform's transfer is
 * one atomic migration tag) does not bootstrap: no ownership changes mid-run,
 * and the ambiguous full-entry deploy fails loudly instead. An unknown origin
 * probe or a missing namespace listing outside a fresh fleet also fails closed.
 */
function classifyPlatformRuntimeBootstrap(
	input: OriginFleetProbe,
	mode: OriginProductionDeployMode,
) {
	const none = {
		platformRuntimeBootstrap: false,
		resumesRuntimeTransfer: false,
	}
	if (input.originScriptExists === null) return none
	if (!input.namespaces) {
		return { ...none, platformRuntimeBootstrap: mode === 'fresh' }
	}
	const scriptNames = input.scriptNames ?? productionFleetScriptNames
	const namespaces = input.namespaces
	const runtimeOwned = classesOnScript(namespaces, scriptNames.runtime)
	const originOwned = classesOnScript(namespaces, scriptNames.origin)
	const runtimeOwnsAll = runtimeOwnedClassNames.every((className) =>
		runtimeOwned.has(className),
	)
	const resumesRuntimeTransfer =
		mode === 'ambiguous' &&
		input.originScriptExists === true &&
		runtimeOwnedClassNames.every((className) => originOwned.has(className)) &&
		everyClassOnScript(
			namespaces,
			scriptNames.platform,
			platformOwnedClassNames,
		) &&
		!platformOwnedClassNames.some((className) => originOwned.has(className)) &&
		!runtimeOwnedClassNames.some((className) => runtimeOwned.has(className))
	return {
		platformRuntimeBootstrap:
			!runtimeOwnsAll && (mode === 'fresh' || resumesRuntimeTransfer),
		resumesRuntimeTransfer,
	}
}

function classifyOriginOwnership(
	input: OriginFleetProbe,
): OriginProductionScriptState {
	const scriptNames = input.scriptNames ?? productionFleetScriptNames
	if (input.originScriptExists === null) {
		return scriptState(
			'ambiguous',
			'Origin script existence is unknown; keep the full entry and do not bootstrap transfers.',
		)
	}

	if (input.namespaces) {
		const originOwnedTransferredClassNames = transferredClassesOnScript(
			input.namespaces,
			scriptNames.origin,
		)
		const destinationsOwnTransferred =
			everyClassOnScript(
				input.namespaces,
				scriptNames.platform,
				platformOwnedClassNames,
			) &&
			everyClassOnScript(
				input.namespaces,
				scriptNames.runtime,
				runtimeOwnedClassNames,
			)
		const originOwnsTransferred = originOwnedTransferredClassNames.length > 0
		const destinationsOwnAnyTransferred =
			anyTransferredClassOnScript(input.namespaces, scriptNames.platform) ||
			anyTransferredClassOnScript(input.namespaces, scriptNames.runtime)

		if (
			!input.originScriptExists &&
			!destinationsOwnTransferred &&
			!originOwnsTransferred &&
			!destinationsOwnAnyTransferred
		) {
			return scriptState(
				'fresh',
				'Origin script is missing and no transferred Durable Object namespace exists on origin, platform, or runtime.',
			)
		}

		// Origin bootstrap already created the classes, but platform/runtime
		// never took ownership. Retry the same first-deploy path: full entry
		// with local bindings, then the existing transferred_classes tags.
		// Mixed ownership (destinations already own some names) stays
		// ambiguous — a second transfer of those names is unsafe.
		if (
			input.originScriptExists &&
			originOwnsTransferred &&
			!destinationsOwnAnyTransferred
		) {
			return scriptState(
				'fresh',
				'Origin still owns transferred classes and platform/runtime own none of them; retry full-entry bootstrap then transfer.',
				originOwnedTransferredClassNames,
			)
		}

		if (
			input.originScriptExists &&
			destinationsOwnTransferred &&
			!originOwnsTransferred
		) {
			return scriptState(
				'steady',
				'Origin script exists, platform and runtime own every transferred class, and origin owns none of them.',
			)
		}

		return scriptState(
			'ambiguous',
			'Durable Object namespace ownership does not match a fresh script or a completed platform/runtime transfer.',
			originOwnedTransferredClassNames,
		)
	}

	if (
		input.originScriptExists === false &&
		input.platformScriptExists === false &&
		input.runtimeScriptExists === false
	) {
		return scriptState(
			'fresh',
			'Origin, platform, and runtime scripts are all missing (namespace listing unavailable).',
		)
	}

	// All three scripts exist but we could not list namespace ownership.
	// Treat as steady and let Cloudflare error 10064 reject a slim upload
	// if origin still owns a transferred class. Classifying this as
	// ambiguous would upload the full entry with cross-script bindings,
	// which serves requests to the wrong script when origin still owns
	// those classes.
	if (
		input.originScriptExists === true &&
		input.platformScriptExists === true &&
		input.runtimeScriptExists === true
	) {
		return scriptState(
			'steady',
			'Origin, platform, and runtime scripts all exist (namespace listing unavailable; Cloudflare rejects a slim upload if origin still owns a class).',
		)
	}

	return scriptState(
		'ambiguous',
		'Could not list Durable Object namespaces, and the three production scripts are not uniformly present or missing.',
	)
}

export async function getCloudflareWorkerScriptExists(input: {
	accountId: string
	apiToken: string
	scriptName: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
}): Promise<boolean> {
	try {
		await cloudflareApiRequest<Record<string, unknown>>({
			accountId: input.accountId,
			apiToken: input.apiToken,
			pathname: `/workers/scripts/${encodeURIComponent(input.scriptName)}`,
			...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
			...(input.fetcher ? { fetcher: input.fetcher } : {}),
		})
		return true
	} catch (error) {
		if (isCloudflareNotFoundError(error)) return false
		if (isCloudflareOkNonJsonError(error)) return true
		throw error
	}
}

function readNamespaceOwnership(
	entry: unknown,
): DurableObjectNamespaceOwnership | null {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
	const record = entry as Record<string, unknown>
	const script = record.script
	const className =
		typeof record.class === 'string'
			? record.class
			: typeof record.class_name === 'string'
				? record.class_name
				: null
	if (typeof script !== 'string' || script.length === 0) return null
	if (!className || className.length === 0) return null
	return { script, className }
}

async function listCloudflareDurableObjectNamespaces(input: {
	accountId: string
	apiToken: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
}): Promise<Array<DurableObjectNamespaceOwnership>> {
	const namespaces: Array<DurableObjectNamespaceOwnership> = []
	let page = 1
	for (;;) {
		const payload = await cloudflareApiRequest<unknown>({
			accountId: input.accountId,
			apiToken: input.apiToken,
			pathname: `/workers/durable_objects/namespaces?page=${String(page)}&per_page=100`,
			...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
			...(input.fetcher ? { fetcher: input.fetcher } : {}),
		})
		const result = payload.result
		const batch = Array.isArray(result)
			? result
			: result &&
				  typeof result === 'object' &&
				  Array.isArray((result as { namespaces?: unknown }).namespaces)
				? (result as { namespaces: Array<unknown> }).namespaces
				: null
		if (!batch) {
			throw new Error(
				'Cloudflare Durable Object namespace listing returned a malformed result.',
			)
		}
		for (const entry of batch) {
			const ownership = readNamespaceOwnership(entry)
			if (ownership) namespaces.push(ownership)
		}
		const totalPages = payload.result_info?.total_pages
		if (typeof totalPages !== 'number' || page >= totalPages) break
		page += 1
	}
	return namespaces
}

export async function inspectOriginProductionScriptState(input: {
	accountId: string
	apiToken: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
	scriptNames?: OriginFleetScriptNames
}): Promise<OriginProductionScriptState> {
	const { scriptNames = productionFleetScriptNames, ...client } = input
	try {
		const [originScriptExists, platformScriptExists, runtimeScriptExists] =
			await Promise.all([
				getCloudflareWorkerScriptExists({
					...client,
					scriptName: scriptNames.origin,
				}),
				getCloudflareWorkerScriptExists({
					...client,
					scriptName: scriptNames.platform,
				}),
				getCloudflareWorkerScriptExists({
					...client,
					scriptName: scriptNames.runtime,
				}),
			])
		let namespaces: Array<DurableObjectNamespaceOwnership> | null = null
		try {
			namespaces = await listCloudflareDurableObjectNamespaces(client)
		} catch (error) {
			console.error(
				`Durable Object namespace listing failed; classifying from script existence only. ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		return classifyOriginProductionScriptState({
			originScriptExists,
			platformScriptExists,
			runtimeScriptExists,
			namespaces,
			scriptNames,
		})
	} catch (error) {
		return scriptState(
			'ambiguous',
			`Cloudflare script probe failed (${error instanceof Error ? error.message : String(error)}); keep the full entry and do not bootstrap transfers.`,
		)
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

/**
 * Preview-style first origin deploy: the script must locally own every
 * transferred class so `new_sqlite_classes` can create them before
 * platform/runtime `transferred_classes` runs.
 */
export function stripOriginCrossScriptClassBindings(
	config: Record<string, unknown>,
	scriptNames: ReadonlySet<string> = new Set([
		productionPlatformScriptName,
		productionRuntimeScriptName,
	]),
) {
	const env = asRecord(config.env)
	const productionEnv = env ? asRecord(env.production) : null
	const targets = [config, productionEnv].filter(
		(entry): entry is Record<string, unknown> => entry !== null,
	)
	for (const target of targets) {
		const durableObjects = asRecord(target.durable_objects)
		const bindings = durableObjects?.bindings
		if (Array.isArray(bindings)) {
			// Native destination classes have no origin namespace to transfer.
			// Omit them until their owning script has been created.
			const bootstrapBindings = bindings.filter((entry) => {
				const binding = asRecord(entry)
				return !(
					typeof binding?.script_name === 'string' &&
					scriptNames.has(binding.script_name) &&
					typeof binding.class_name === 'string' &&
					!transferredClassNames.some((name) => name === binding.class_name)
				)
			})
			if (durableObjects) durableObjects.bindings = bootstrapBindings

			for (const entry of bootstrapBindings) {
				const binding = asRecord(entry)
				if (!binding) continue
				if (
					typeof binding.script_name === 'string' &&
					scriptNames.has(binding.script_name)
				) {
					delete binding.script_name
				}
			}
		}
		const workflows = target.workflows
		if (Array.isArray(workflows)) {
			for (const entry of workflows) {
				const workflow = asRecord(entry)
				if (!workflow) continue
				if (
					typeof workflow.script_name === 'string' &&
					scriptNames.has(workflow.script_name)
				) {
					delete workflow.script_name
					// Preview's first origin deploy uses a distinct workflow
					// name for the same reason: workflows cannot transfer, and
					// k2-runtime later claims k2-runtime-dynamic-callable-workflows.
					workflow.name = productionOriginBootstrapWorkflowName
				}
			}
		}
	}
	return config
}

/**
 * Ambiguous mixed ownership: origin still has some transferred classes
 * while destinations already own others. Keep cross-script bindings for
 * classes origin no longer owns; bind the rest locally so requests do not
 * follow `script_name` to a script that does not have the storage.
 *
 * Does not force a transfer. A second `transferred_classes` of a name the
 * destination already owns is unsafe.
 */
export function stripOriginBindingsForLocallyOwnedClasses(
	config: Record<string, unknown>,
	ownedClassNames: ReadonlyArray<string>,
) {
	const owned = new Set(ownedClassNames)
	if (owned.size === 0) return config

	const env = asRecord(config.env)
	const productionEnv = env ? asRecord(env.production) : null
	const targets = [config, productionEnv].filter(
		(entry): entry is Record<string, unknown> => entry !== null,
	)
	const runtimeOwned = new Set<string>(runtimeOwnedClassNames)
	let strippedRuntimeClass = false

	for (const target of targets) {
		const durableObjects = asRecord(target.durable_objects)
		const bindings = durableObjects?.bindings
		if (Array.isArray(bindings)) {
			for (const entry of bindings) {
				const binding = asRecord(entry)
				if (!binding) continue
				if (typeof binding.class_name !== 'string') continue
				if (!owned.has(binding.class_name)) continue
				if (
					typeof binding.script_name === 'string' &&
					(binding.script_name === productionPlatformScriptName ||
						binding.script_name === productionRuntimeScriptName)
				) {
					if (runtimeOwned.has(binding.class_name)) {
						strippedRuntimeClass = true
					}
					delete binding.script_name
				}
			}
		}
	}

	if (strippedRuntimeClass) {
		for (const target of targets) {
			const workflows = target.workflows
			if (!Array.isArray(workflows)) continue
			for (const entry of workflows) {
				const workflow = asRecord(entry)
				if (!workflow) continue
				if (workflow.script_name !== productionRuntimeScriptName) continue
				delete workflow.script_name
				workflow.name = productionOriginBootstrapWorkflowName
			}
		}
	}

	return config
}

/**
 * Slim origin scripts never own a Durable Object class: platform and
 * runtime create every class themselves (`new_sqlite_classes` in their
 * own envs), so the origin's committed migration history must not
 * replay on the slim upload. A fresh script — or a Vite-flattened
 * `dist/ssr/wrangler.json` that Wrangler treats as first apply — would
 * otherwise create namespaces for classes the slim entry does not export
 * (Cloudflare rejects the upload with 10070), and a legacy full-entry
 * script would keep re-owning them. Wrangler uploads no migration steps
 * when the config declares none, which leaves any already-created
 * namespaces on a legacy script untouched.
 *
 * Preview always strips. Steady-state and fresh production slim uploads
 * strip too; the full-entry bootstrap config keeps the history so
 * `new_sqlite_classes` can create classes before transfer.
 * Permanent: stored data or clients from before this change still exist.
 */
export function stripOriginDurableObjectMigrations(
	config: Record<string, unknown>,
	envName: string,
) {
	delete config.migrations
	const env = asRecord(config.env)
	const targetEnv = env ? asRecord(env[envName]) : null
	if (targetEnv) delete targetEnv.migrations
	return config
}

export function originBootstrapConfigPath(generatedConfigPath: string) {
	if (!generatedConfigPath.endsWith('.generated.json')) {
		throw new Error(
			`Origin bootstrap config path requires a .generated.json out-config (got ${JSON.stringify(generatedConfigPath)}) so the bootstrap file cannot overwrite the slim generated config.`,
		)
	}
	return generatedConfigPath.replace(
		/\.generated\.json$/u,
		'-bootstrap.generated.json',
	)
}

export async function writeOriginBootstrapWranglerConfig(input: {
	generatedConfig: Record<string, unknown>
	outConfigPath: string
}) {
	const bootstrap = structuredClone(input.generatedConfig)
	bootstrap.main = defaultDevEntryPath
	stripOriginCrossScriptClassBindings(bootstrap)
	const resolvedOut = path.resolve(input.outConfigPath)
	await writeFile(
		resolvedOut,
		`${JSON.stringify(bootstrap, null, '\t')}\n`,
		'utf8',
	)
	return resolvedOut
}
