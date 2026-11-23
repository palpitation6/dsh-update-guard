/**
 * Host half of the update guard.
 *
 * Registers one authenticated exact Fetch route on the browser transport. The
 * page asks it which installed plugins declare support for the release the
 * Desktop shell is about to download; nothing is cached and no plugin is
 * activated or modified.
 */

import { REPORT_PATH, buildReport, readInventory } from './compat.js'

/**
 * Answer with a body and no-store caching.
 * @param {unknown} body - JSON-serializable payload
 * @param {number} status - HTTP status
 * @returns {Response} the response
 */
function json(body, status) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Read the compatibility report for the requested target version.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host context
 * @param {Request} request - incoming GET request
 * @returns {Promise<Response>} the report or a failure the page reports
 */
async function respond(ctx, request) {
  const target = new URL(request.url).searchParams.get('version')
  if (typeof target !== 'string' || target.trim() === '') {
    return json({ error: 'missing-version' }, 400)
  }
  try {
    const manager = ctx.get('pluginManager')
    const inventory = manager === undefined ? undefined : await readInventory(manager)
    const report = await buildReport({ targetVersion: target.trim(), inventory })
    return json(report, 200)
  } catch (error) {
    return json({ error: 'report-failed', message: error instanceof Error ? error.message : String(error) }, 500)
  }
}

/**
 * Register the report route for as long as this bundle is mounted.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host context
 */
export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined || connection.fetch === undefined) return
  ctx.effect(() => connection.fetch.register({
    path: REPORT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => respond(ctx, request),
  }), 'update-guard: plugin compatibility route')
}
