import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseProductionQueueResources } from './production-queue-resources.ts'
import { parseJsonc } from './resource-utils.ts'

function createProductionEnv() {
	const consumer = (queue: string, settings: Record<string, number> = {}) => ({
		queue,
		max_batch_size: 10,
		max_batch_timeout: 5,
		max_retries: 3,
		...settings,
		dead_letter_queue: `${queue}-dlq`,
	})
	const deadLetterConsumer = (queue: string) => ({
		queue,
		max_batch_size: 10,
		max_batch_timeout: 5,
		max_retries: 100,
		retry_delay: 60,
	})
	return {
		queues: {
			producers: [
				'PLATFORM_FEEDBACK',
				'COMMUNITY_ACTIVITY',
				'COMMUNITY_LISTING_PUBLISHED',
				'PACKAGE_EVENTS',
				'WEBHOOK',
			].map((name) => ({
				binding: `${name}_DISPATCH_QUEUE`,
				queue: `k2-${name.toLowerCase().replaceAll('_', '-')}-dispatch`,
			})),
			consumers: [
				consumer('k2-email-delivery'),
				consumer('k2-artifacts-repo-events'),
				consumer('k2-platform-feedback-dispatch'),
				consumer('k2-community-activity-dispatch'),
				consumer('k2-community-listing-published-dispatch'),
				consumer('k2-package-events-dispatch', { max_concurrency: 16 }),
				consumer('k2-webhook-dispatch', {
					max_batch_size: 1,
					max_retries: 10,
					max_concurrency: 16,
				}),
				...[
					'k2-email-delivery-dlq',
					'k2-artifacts-repo-events-dlq',
					'k2-platform-feedback-dispatch-dlq',
					'k2-community-activity-dispatch-dlq',
					'k2-community-listing-published-dispatch-dlq',
					'k2-package-events-dispatch-dlq',
					'k2-webhook-dispatch-dlq',
					'k2-scheduled-dispatch-dlq',
				].map(deadLetterConsumer),
			],
		},
	}
}

function parseEnv(
	mutate: (env: ReturnType<typeof createProductionEnv>) => void,
) {
	const productionEnv = createProductionEnv()
	mutate(productionEnv)
	return () =>
		parseProductionQueueResources({
			productionEnv,
			configPath: 'wrangler.jsonc',
		})
}

test('production queue config requires all consumers and consistent producers', () => {
	const wranglerConfig = parseJsonc<{
		env: { production: Record<string, unknown> }
	}>(
		readFileSync(
			new URL('../../packages/worker/wrangler.jsonc', import.meta.url),
			'utf8',
		),
	)
	expect(
		parseProductionQueueResources({
			productionEnv: wranglerConfig.env.production,
			configPath: 'packages/worker/wrangler.jsonc',
		}),
	).toEqual({
		emailDeliveryQueueName: 'k2-email-delivery',
		emailDeliveryDeadLetterQueueName: 'k2-email-delivery-dlq',
		artifactsRepoEventsQueueName: 'k2-artifacts-repo-events',
		artifactsRepoEventsDeadLetterQueueName: 'k2-artifacts-repo-events-dlq',
		platformFeedbackDispatchQueueName: 'k2-platform-feedback-dispatch',
		platformFeedbackDispatchDeadLetterQueueName:
			'k2-platform-feedback-dispatch-dlq',
		communityActivityDispatchQueueName: 'k2-community-activity-dispatch',
		communityActivityDispatchDeadLetterQueueName:
			'k2-community-activity-dispatch-dlq',
		communityListingPublishedDispatchQueueName:
			'k2-community-listing-published-dispatch',
		communityListingPublishedDispatchDeadLetterQueueName:
			'k2-community-listing-published-dispatch-dlq',
		packageEventsDispatchQueueName: 'k2-package-events-dispatch',
		packageEventsDispatchDeadLetterQueueName: 'k2-package-events-dispatch-dlq',
		webhookDispatchQueueName: 'k2-webhook-dispatch',
		webhookDispatchDeadLetterQueueName: 'k2-webhook-dispatch-dlq',
	})

	expect(parseEnv(() => {})).not.toThrow()
	expect(
		parseEnv((env) => {
			env.queues.consumers.pop()
		}),
	).toThrow('exactly 15 production Queue consumers')
	expect(
		parseEnv((env) => {
			env.queues.consumers = env.queues.consumers.map((consumer) =>
				consumer.queue === 'k2-scheduled-dispatch-dlq'
					? { ...consumer, queue: 'kody-unrelated-queue' }
					: consumer,
			)
		}),
	).toThrow(
		'must define the production dead-letter Queue consumer "k2-scheduled-dispatch-dlq"',
	)
	expect(
		parseEnv((env) => {
			const consumer = env.queues.consumers.find(
				(candidate) => candidate.queue === 'k2-platform-feedback-dispatch-dlq',
			)
			Object.assign(consumer ?? {}, { max_retries: 3 })
		}),
	).toThrow(
		'invalid production dead-letter consumer settings for "k2-platform-feedback-dispatch-dlq"',
	)
	expect(
		parseEnv((env) => {
			env.queues.producers[0] = {
				binding: 'PLATFORM_FEEDBACK_DISPATCH_QUEUE',
				queue: 'wrong-queue',
			}
		}),
	).toThrow(
		'must bind "PLATFORM_FEEDBACK_DISPATCH_QUEUE" to "k2-platform-feedback-dispatch"',
	)
	for (const [binding, queue] of [
		['COMMUNITY_ACTIVITY_DISPATCH_QUEUE', 'k2-community-activity-dispatch'],
		[
			'COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE',
			'k2-community-listing-published-dispatch',
		],
		['PACKAGE_EVENTS_DISPATCH_QUEUE', 'k2-package-events-dispatch'],
	]) {
		expect(
			parseEnv((env) => {
				env.queues.producers = env.queues.producers.filter(
					(producer) => producer.binding !== binding,
				)
			}),
		).toThrow(`must bind "${binding}" to "${queue}"`)
	}

	for (const invalidSettings of [
		{ max_batch_size: 2 },
		{ max_batch_timeout: 1 },
		{ max_concurrency: 1 },
	]) {
		expect(
			parseEnv((env) => {
				const webhook = env.queues.consumers.find(
					(consumer) => consumer.queue === 'k2-webhook-dispatch',
				)
				Object.assign(webhook ?? {}, invalidSettings)
			}),
		).toThrow('invalid production consumer settings for "k2-webhook-dispatch"')
	}
})
