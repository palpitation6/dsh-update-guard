/**
 * Predict whether the profile's plugins load on a target DSH release.
 *
 * DSH decides that question in `@deepseek-ai/dsh-app-boot`
 * (`evaluatePluginCompatibility`): an own `engines.dsh` range decides alone,
 * otherwise every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer range must
 * match, and ranges are evaluated with
 * `semver.satisfies(version, range, { includePrerelease: true })`. This module
 * reproduces that rule without importing the installation, so the answer a
 * page shows before downloading is the answer the updated Host will apply
 * afterwards.
 *
 * Everything here is Host-side: it reads manifests from the profile and the
 * installation and never loads or activates a plugin.
 */

import { createRequire } from 'node:module'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Route the browser half asks for this report. */
export const REPORT_PATH = '/api/dsh-update-guard/report'

/** This bundle's package name, used to locate its own profile. */
export const SELF_PACKAGE = '@palpitation6/dsh-update-guard'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const DSH_PEER_PREFIX = '@deepseek-ai/dsh-'
const WORKSPACE_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*'])
const XRANGE = /^[xX*]$/

/* ------------------------------------------------------------------ *
 * SemVer
 * ------------------------------------------------------------------ */

/**
 * Parse a complete semantic version.
 * @param {unknown} value - candidate text such as `0.2.3-alpha.2`
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] } | undefined}
 *   the parsed version, or `undefined` when the text is not a version
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined
  const match = /^\s*[v=]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(value)
  if (match === null) return undefined
  const prerelease = splitIdentifiers(match[4])
  if (prerelease.some((part) => !/^[0-9A-Za-z-]+$/.test(part))) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease }
}

/**
 * @param {string | undefined} text - dot-separated prerelease identifiers
 * @returns {string[]} identifiers, empty for the empty text
 */
function splitIdentifiers(text) {
  return text === undefined ? [] : text.split('.').filter((part) => part !== '')
}

/**
 * Compare two parsed versions using SemVer precedence.
 * @param {{ major: number, minor: number, patch: number, prerelease: string[] }} a - left version
 * @param {{ major: number, minor: number, patch: number, prerelease: string[] }} b - right version
 * @returns {number} negative, zero, or positive
 */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * @param {string} text - possibly partial version
 * @returns {{ components: number[], prerelease: string[] } | undefined}
 *   the numeric components present (`[]` for a wildcard) and an optional prerelease
 */
function parsePartial(text) {
  const raw = String(text).trim().replace(/^[v=]\s*/, '')
  if (raw === '') return { components: [], prerelease: [] }
  const match = /^([0-9]+|[xX*])(?:\.([0-9]+|[xX*]))?(?:\.([0-9]+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw)
  if (match === null) return undefined
  const components = []
  for (const part of [match[1], match[2], match[3]]) {
    if (part === undefined || XRANGE.test(part)) break
    components.push(Number(part))
  }
  const prerelease = splitIdentifiers(match[4])
  if (prerelease.some((part) => !/^[0-9A-Za-z-]+$/.test(part))) return undefined
  return { components, prerelease }
}

/**
 * @param {{ components: number[], prerelease: string[] }} partial - parsed partial
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] }} a filled version
 */
function versionOfPartial(partial) {
  const [major = 0, minor = 0, patch = 0] = partial.components
  return { major, minor, patch, prerelease: partial.prerelease }
}

/**
 * @param {string} prerelease - identifiers after `-`
 * @returns {string} version text ready for a comparator
 */
function textWithPrerelease(major, minor, patch, prerelease) {
  const suffix = prerelease === '' ? '' : `-${prerelease}`
  return `${major}.${minor}.${patch}${suffix}`
}

/**
 * Test whether a version satisfies a range the way DSH tests plugin ranges.
 *
 * Mirrors `semver.satisfies(version, range, { includePrerelease: true })`,
 * including its desugaring of carets, tildes, x-ranges, and hyphen ranges. An
 * unparsable range satisfies nothing, which is also what DSH reports.
 * @param {string} version - complete version text
 * @param {string} range - semver range text
 * @returns {boolean} whether the version satisfies the range
 */
export function satisfies(version, range) {
  const parsed = parseVersion(version)
  if (parsed === undefined) return false
  const sets = parseRange(range)
  if (sets === undefined) return false
  return sets.some((comparators) => comparators.every((comparator) => testComparator(parsed, comparator)))
}

/**
 * @param {string} range - semver range text
 * @returns {Array<Array<{ operator: string, version: object }>> | undefined}
 *   one list of comparators per `||` alternative, or `undefined` when invalid
 */
function parseRange(range) {
  if (typeof range !== 'string') return undefined
  const raw = range.trim().replace(/\s+/g, ' ')
  if (raw === '') return [[]]
  const sets = []
  for (const alternative of raw.split('||')) {
    const comparators = parseComparatorSet(alternative.trim())
    if (comparators === undefined) return undefined
    sets.push(comparators)
  }
  return sets.length === 0 ? undefined : sets
}

/**
 * Desugar one space-separated comparator set into concrete comparators.
 * @param {string} text - one `||` alternative without surrounding whitespace
 * @returns {Array<{ operator: string, version: object }> | undefined} comparators, or `undefined` when invalid
 */
function parseComparatorSet(text) {
  if (text === '') return []
  let source = text.replace(/\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*/g, '')
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(source)
  if (hyphen !== null) {
    const replaced = hyphenRange(hyphen[1], hyphen[2])
    if (replaced === undefined) return undefined
    source = replaced
  }
  source = source.replace(/(>=|<=|>|<|=|~>|~|\^)\s+/g, '$1')
  const comparators = []
  for (const token of source.split(/\s+/).filter((part) => part !== '')) {
    const expanded = desugarToken(token)
    if (expanded === undefined) return undefined
    for (const value of expanded) {
      if (value === '*') continue
      if (value === '>=0.0.0-0') continue
      const parsed = comparatorOf(value)
      if (parsed === undefined) return undefined
      comparators.push(parsed)
    }
  }
  return comparators
}

/**
 * @param {string} from - hyphen lower bound source
 * @param {string} to - hyphen upper bound source
 * @returns {string | undefined} an equivalent comparator set, or `undefined` when invalid
 */
function hyphenRange(from, to) {
  const low = parsePartial(from)
  const high = parsePartial(to)
  if (low === undefined || high === undefined) return undefined
  let lower = ''
  if (low.components.length === 0) lower = ''
  else if (low.components.length === 1) lower = `>=${low.components[0]}.0.0-0`
  else if (low.components.length === 2) lower = `>=${low.components[0]}.${low.components[1]}.0-0`
  else if (low.prerelease.length > 0) lower = `>=${textWithPrerelease(low.components[0], low.components[1], low.components[2], low.prerelease.join('.'))}`
  else lower = `>=${low.components[0]}.${low.components[1]}.${low.components[2]}-0`
  let upper = ''
  if (high.components.length === 0) upper = ''
  else if (high.components.length === 1) upper = `<${high.components[0] + 1}.0.0-0`
  else if (high.components.length === 2) upper = `<${high.components[0]}.${high.components[1] + 1}.0-0`
  else if (high.prerelease.length > 0) upper = `<=${textWithPrerelease(high.components[0], high.components[1], high.components[2], high.prerelease.join('.'))}`
  else upper = `<${high.components[0]}.${high.components[1]}.${high.components[2] + 1}-0`
  return `${lower} ${upper}`.trim()
}

/**
 * @param {string} text - one comparator token such as `^0.2.3-alpha.2` or `>=1.2`
 * @returns {string[] | undefined} concrete comparator texts (`'*'` for any), or `undefined` when invalid
 */
function desugarToken(text) {
  const match = /^(>=|<=|>|<|=|~>|~|\^)?(.*)$/.exec(text)
  if (match === null) return undefined
  const operator = match[1] ?? ''
  const target = match[2] ?? ''
  const partial = parsePartial(target)
  if (partial === undefined) return undefined
  const [major = 0, minor = 0, patch = 0] = partial.components
  const prerelease = partial.prerelease.join('.')
  const hasMajor = partial.components.length >= 1
  const hasMinor = partial.components.length >= 2
  const hasPatch = partial.components.length >= 3
  const lower = textWithPrerelease(major, minor, patch, prerelease)

  if (operator === '^') {
    if (!hasMajor) return ['*']
    if (!hasMinor) return [`>=${major}.0.0-0`, `<${major + 1}.0.0-0`]
    if (!hasPatch) {
      return major === 0
        ? [`>=0.${minor}.0-0`, `<0.${minor + 1}.0-0`]
        : [`>=${major}.${minor}.0-0`, `<${major + 1}.0.0-0`]
    }
    if (major === 0 && minor === 0) return [`>=${lower}`, `<0.0.${patch + 1}-0`]
    if (major === 0) return [`>=${lower}`, `<0.${minor + 1}.0-0`]
    return [`>=${lower}`, `<${major + 1}.0.0-0`]
  }

  if (operator === '~' || operator === '~>') {
    if (!hasMajor) return ['*']
    if (!hasMinor) return [`>=${major}.0.0-0`, `<${major + 1}.0.0-0`]
    if (!hasPatch) return [`>=${major}.${minor}.0-0`, `<${major}.${minor + 1}.0-0`]
    return [`>=${lower}`, `<${major}.${minor + 1}.0-0`]
  }

  if (!hasMajor) return operator === '>' || operator === '<' ? ['<0.0.0-0'] : ['*']

  if (operator === '' || operator === '=') {
    if (!hasMinor) return [`>=${major}.0.0-0`, `<${major + 1}.0.0-0`]
    if (!hasPatch) return [`>=${major}.${minor}.0-0`, `<${major}.${minor + 1}.0-0`]
    return [`=${lower}`]
  }
  if (operator === '>=') {
    if (!hasMinor) return [`>=${major}.0.0-0`]
    if (!hasPatch) return [`>=${major}.${minor}.0-0`]
    return [`>=${lower}`]
  }
  if (operator === '>') {
    if (!hasMinor) return [`>=${major + 1}.0.0-0`]
    if (!hasPatch) return [`>=${major}.${minor + 1}.0-0`]
    return [`>${lower}`]
  }
  if (operator === '<') {
    if (!hasMinor) return [`<${major}.0.0-0`]
    if (!hasPatch) return [`<${major}.${minor}.0-0`]
    return [`<${lower}`]
  }
  if (operator === '<=') {
    if (!hasMinor) return [`<${major + 1}.0.0-0`]
    if (!hasPatch) return [`<${major}.${minor + 1}.0-0`]
    return [`<=${lower}`]
  }
  return undefined
}

/**
 * @param {string} text - one concrete comparator
 * @returns {{ operator: string, version: object } | undefined} the comparator, or `undefined` when invalid
 */
function comparatorOf(text) {
  const match = /^(>=|<=|>|<|=)?(.*)$/.exec(text)
  if (match === null) return undefined
  const version = parseVersion(match[2] ?? '')
  if (version === undefined) return undefined
  return { operator: match[1] ?? '=', version }
}

/**
 * @param {object} version - parsed version
 * @param {{ operator: string, version: object }} comparator - concrete comparator
 * @returns {boolean} whether the version satisfies the comparator
 */
function testComparator(version, comparator) {
  const order = compareVersions(version, comparator.version)
  switch (comparator.operator) {
    case '=':
      return order === 0
    case '>':
      return order > 0
    case '>=':
      return order >= 0
    case '<':
      return order < 0
    case '<=':
      return order <= 0
    default:
      return false
  }
}

/* ------------------------------------------------------------------ *
 * Plugin requirements
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value - candidate value
 * @returns {value is Record<string, unknown>} whether it is a plain object
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the DSH requirements a manifest declares and test them against a target.
 *
 * `engines.dsh` decides alone when present; otherwise every DSH peer range must
 * hold, including the `workspace:` spellings that mean the running version. A
 * malformed `engines.dsh` is reported as unmet, as DSH refuses such a manifest.
 * @param {unknown} manifest - parsed package.json
 * @param {string} runtimeVersion - DSH version to test against
 * @returns {{ declared: boolean, requirements: Record<string, string>, unmet: Record<string, string> }}
 *   the declared ranges and the ones the target does not satisfy
 */
export function evaluateRequirements(manifest, runtimeVersion) {
  if (!isRecord(manifest)) return { declared: false, requirements: {}, unmet: {} }
  const engines = isRecord(manifest.engines) ? manifest.engines : {}
  if (Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') {
      return { declared: true, requirements: { 'engines.dsh': String(range) }, unmet: { 'engines.dsh': String(range) } }
    }
    const unmet = range.trim() !== '' && satisfies(runtimeVersion, range) ? {} : { 'engines.dsh': range }
    return { declared: true, requirements: { 'engines.dsh': range }, unmet }
  }
  const peers = isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {}
  const requirements = {}
  const unmet = {}
  for (const [name, range] of Object.entries(peers)) {
    if (name !== DSH_PACKAGE && !name.startsWith(DSH_PEER_PREFIX)) continue
    if (typeof range !== 'string') continue
    requirements[name] = range
    const effective = WORKSPACE_RANGES.has(range) ? runtimeVersion : range
    if (effective.trim() === '' || !satisfies(runtimeVersion, effective)) unmet[name] = range
  }
  return { declared: Object.keys(requirements).length > 0, requirements, unmet }
}

/* ------------------------------------------------------------------ *
 * Profile inventory
 * ------------------------------------------------------------------ */

const cache = { profileDir: undefined, installDir: undefined }

/**
 * Find the profile directory a live plugin row resolves into.
 *
 * The Host process does not inherit the launcher's profile environment, but a
 * row imported by a `file:`/absolute specifier names its own location, which
 * identifies the profile the running process actually serves.
 * @param {{ rows?: object[] } | undefined} inventory - live manager rows
 * @returns {Promise<string | undefined>} an absolute profile directory
 */
async function profileFromInventory(inventory) {
  if (!isRecord(inventory) || !Array.isArray(inventory.rows)) return undefined
  for (const row of inventory.rows) {
    if (!isRecord(row) || typeof row.moduleName !== 'string') continue
    const spec = row.moduleName
    let file
    if (spec.startsWith('file:')) {
      try {
        file = fileURLToPath(spec)
      } catch {
        continue
      }
    } else if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) {
      file = spec
    } else {
      continue
    }
    const marker = `${path.sep}profiles${path.sep}`
    const index = file.indexOf(marker)
    if (index < 0) continue
    const name = file.slice(index + marker.length).split(/[\\/]/)[0]
    if (name === undefined || name === '') continue
    const directory = path.join(file.slice(0, index), 'profiles', name)
    if (await isDirectory(directory)) return directory
  }
  return undefined
}

/**
 * Resolve the profile directory that owns this bundle.
 *
 * Prefers a live row that names its own location, then the launcher-provided
 * `DSH_PROFILE_DIR`, then the profile under the Harness home whose manifest
 * selects or depends on this bundle, so a Host whose process environment
 * carries no profile facts still answers.
 * @param {{ rows?: object[] } | undefined} [inventory] - live manager rows
 * @returns {Promise<string | undefined>} an absolute profile directory
 */
export async function resolveProfileDir(inventory) {
  if (cache.profileDir !== undefined) return cache.profileDir
  const hinted = await profileFromInventory(inventory)
  if (hinted !== undefined) {
    cache.profileDir = Promise.resolve(hinted)
    return cache.profileDir
  }
  const resolved = await (async () => {
    const explicit = process.env.DSH_PROFILE_DIR
    if (typeof explicit === 'string' && explicit.trim() !== '' && (await isDirectory(explicit))) {
      return path.resolve(explicit)
    }
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
    const root = path.join(home, 'profiles')
    const names = await fsp.readdir(root, { withFileTypes: true })
      .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
      .catch(() => [])
    const preferred = process.env.DSH_PROFILE
    if (typeof preferred === 'string' && names.includes(preferred)) return path.join(root, preferred)
    for (const name of names) {
      const directory = path.join(root, name)
      const manifest = await readJson(path.join(directory, 'package.json'))
      if (!isRecord(manifest)) continue
      const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
      const profile = isRecord(manifest.dsh) && isRecord(manifest.dsh.profile) ? manifest.dsh.profile : {}
      const bundles = Array.isArray(profile.bundles) ? profile.bundles : []
      if (Object.hasOwn(dependencies, SELF_PACKAGE) || bundles.includes(SELF_PACKAGE)) return directory
    }
    return names.length === 1 ? path.join(root, names[0]) : undefined
  })()
  if (resolved !== undefined) cache.profileDir = Promise.resolve(resolved)
  return resolved
}

/**
 * Resolve the dsh installation anchor, when the environment names it.
 * @returns {Promise<string | undefined>} an absolute package directory
 */
export async function resolveInstallDir() {
  if (cache.installDir !== undefined) return cache.installDir
  cache.installDir = (async () => {
    const explicit = process.env.DSH_INSTALL_DIR
    if (typeof explicit === 'string' && explicit.trim() !== '' && (await isDirectory(explicit))) {
      return path.resolve(explicit)
    }
    return undefined
  })()
  return cache.installDir
}

/**
 * Read the profile's currently installed, third-party bundles and rows.
 * @param {{ listBundles?: () => Promise<unknown>, listPlugins?: () => Promise<unknown> } | undefined} manager
 *   the plugin manager service, when the profile composes it
 * @returns {Promise<{ bundles: object[], rows: object[] }>} raw manager rows
 */
export async function readInventory(manager) {
  const bundles = manager !== undefined && typeof manager.listBundles === 'function'
    ? await manager.listBundles().catch(() => [])
    : []
  const rows = manager !== undefined && typeof manager.listPlugins === 'function'
    ? await manager.listPlugins().catch(() => [])
    : []
  return { bundles: Array.isArray(bundles) ? bundles : [], rows: Array.isArray(rows) ? rows : [] }
}

/**
 * Read the profile manifest when no plugin manager answers.
 *
 * The profile `package.json` carries the same facts the manager lists: the
 * selected bundle layers and the installed dependencies. Rows inserted by a
 * hand-written patch are invisible here, so this is only a fallback.
 * @param {string} profileDir - absolute profile directory
 * @returns {Promise<{ bundles: object[], rows: object[] }>} candidate entries in manager shape
 */
export async function readProfileInventory(profileDir) {
  const manifest = await readJson(path.join(profileDir, 'package.json'))
  if (!isRecord(manifest)) return { bundles: [], rows: [] }
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
  const profile = isRecord(manifest.dsh) && isRecord(manifest.dsh.profile) ? manifest.dsh.profile : {}
  const selected = new Set(Array.isArray(profile.bundles) ? profile.bundles.filter((name) => typeof name === 'string') : [])
  const bundles = [...selected]
    .filter((name) => Object.hasOwn(dependencies, name))
    .map((name) => ({
      name,
      official: false,
      availability: 'profile',
      installed: true,
      enabled: true,
    }))
  return { bundles, rows: [] }
}

/**
 * Build the compatibility report for one target release.
 * @param {object} options - report inputs
 * @param {string} options.targetVersion - release the update would install
 * @param {{ bundles: object[], rows: object[] }} [options.inventory] - manager rows
 * @param {string} [options.profileDir] - profile directory override, for tests
 * @param {string} [options.installDir] - installation directory override, for tests
 * @returns {Promise<object>} the report the page renders
 */
export async function buildReport(options) {
  const targetVersion = options.targetVersion
  if (parseVersion(targetVersion) === undefined) throw new Error(`Invalid target version: ${JSON.stringify(targetVersion)}`)
  const provided = options.inventory
  const profileDir = options.profileDir ?? await resolveProfileDir(provided)
  if (profileDir === undefined) throw new Error('The DSH profile directory could not be located')
  const installDir = options.installDir ?? await resolveInstallDir()
  const inventory = provided ?? await readProfileInventory(profileDir)
  const anchors = { profileDir, installDir }
  const seen = new Map()

  for (const bundle of inventory.bundles) {
    if (!isRecord(bundle)) continue
    if (bundle.official === true) continue
    if (bundle.availability !== 'profile') continue
    if (typeof bundle.name !== 'string' || bundle.name === '') continue
    const name = bundle.name
    if (isShippedModule(name) || name === SELF_PACKAGE) continue
    if (seen.has(name)) continue
    seen.set(name, {
      name,
      kind: 'bundle',
      version: typeof bundle.version === 'string' ? bundle.version : undefined,
      enabled: bundle.enabled !== false,
    })
  }

  for (const row of inventory.rows) {
    if (!isRecord(row)) continue
    const spec = row.moduleName
    if (typeof spec !== 'string' || spec === '') continue
    if (isShippedModule(spec)) continue
    const manifest = await manifestForSpec(spec, anchors)
    const name = isRecord(manifest) && typeof manifest.name === 'string'
      ? manifest.name
      : barePackageName(spec) ?? spec
    if (isShippedModule(name) || name === SELF_PACKAGE) continue
    if (seen.has(name)) continue
    seen.set(name, { name, kind: 'plugin', spec, enabled: row.enabled !== false })
  }

  const plugins = []
  for (const candidate of seen.values()) {
    plugins.push(await describeCandidate(candidate, targetVersion, anchors))
  }
  plugins.sort(compareEntries)

  const counts = { total: plugins.length, compatible: 0, incompatible: 0, unspecified: 0, unknown: 0 }
  for (const entry of plugins) counts[entry.status] += 1
  return {
    targetVersion,
    generatedAt: Date.now(),
    plugins,
    counts,
    allCompatible: counts.incompatible === 0,
  }
}

/**
 * @param {object} candidate - one bundle or row
 * @param {string} targetVersion - release to test against
 * @param {{ profileDir: string, installDir: string | undefined }} anchors - manifest lookup roots
 * @returns {Promise<object>} one report row
 */
async function describeCandidate(candidate, targetVersion, anchors) {
  const manifest = candidate.kind === 'bundle'
    ? await manifestForPackage(candidate.name, anchors)
    : await manifestForSpec(candidate.spec, anchors)
  const name = isRecord(manifest) && typeof manifest.name === 'string' ? manifest.name : candidate.name
  const version = isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : candidate.version
  const base = { name, version, kind: candidate.kind, enabled: candidate.enabled }
  if (manifest === undefined) return { ...base, status: 'unknown', note: 'manifest-missing' }
  const evaluation = evaluateRequirements(manifest, targetVersion)
  if (!evaluation.declared) return { ...base, status: 'unspecified' }
  return {
    ...base,
    status: Object.keys(evaluation.unmet).length === 0 ? 'compatible' : 'incompatible',
    requirements: evaluation.requirements,
    unmet: evaluation.unmet,
  }
}

/**
 * @param {object} a - report row
 * @param {object} b - report row
 * @returns {number} sort order: incompatible, unknown, compatible, unspecified, then name
 */
function compareEntries(a, b) {
  const rank = { incompatible: 0, unknown: 1, compatible: 2, unspecified: 3 }
  const difference = (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
  if (difference !== 0) return difference
  return String(a.name).localeCompare(String(b.name))
}

/**
 * @param {string} name - module specifier or package name
 * @returns {boolean} whether DSH itself ships this module
 */
function isShippedModule(name) {
  return name.startsWith('@deepseek-ai/') || name.startsWith('cordis:') || name.startsWith('node:')
}

/**
 * @param {string} spec - module specifier
 * @returns {string | undefined} the package name when the spec is a bare name
 */
function barePackageName(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec) || spec.includes('://')) {
    return undefined
  }
  const segments = spec.split('/')
  if (spec.startsWith('@')) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : spec
  return segments[0]
}

/**
 * @param {string} packageName - npm package name
 * @param {{ profileDir: string, installDir: string | undefined }} anchors - lookup roots
 * @returns {Promise<object | undefined>} the parsed manifest
 */
async function manifestForPackage(packageName, anchors) {
  const segments = packageName.split('/')
  for (const base of [anchors.profileDir, anchors.installDir]) {
    if (base === undefined) continue
    const manifest = await readJson(path.join(base, 'node_modules', ...segments, 'package.json'))
    if (manifest !== undefined) return manifest
  }
  for (const base of [anchors.profileDir, anchors.installDir]) {
    if (base === undefined) continue
    try {
      const resolver = createRequire(path.join(base, 'package.json'))
      const manifest = await readJson(resolver.resolve(`${packageName}/package.json`))
      if (manifest !== undefined) return manifest
    } catch {
      // The package may not export ./package.json; keep looking.
    }
  }
  return undefined
}

/**
 * @param {string} spec - module specifier from a plugin row
 * @param {{ profileDir: string, installDir: string | undefined }} anchors - lookup roots
 * @returns {Promise<object | undefined>} the parsed manifest
 */
async function manifestForSpec(spec, anchors) {
  const file = fileForSpec(spec, anchors)
  if (file === undefined) {
    const name = barePackageName(spec)
    return name === undefined ? undefined : manifestForPackage(name, anchors)
  }
  let directory = file
  try {
    const stat = await fsp.stat(file)
    directory = stat.isDirectory() ? file : path.dirname(file)
  } catch {
    return undefined
  }
  for (;;) {
    const manifest = await readJson(path.join(directory, 'package.json'))
    if (manifest !== undefined) return manifest
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * @param {string} spec - module specifier
 * @param {{ profileDir: string, installDir: string | undefined }} anchors - resolution roots
 * @returns {string | undefined} a filesystem path for path-like specifiers
 */
function fileForSpec(spec, anchors) {
  if (spec.startsWith('file:')) {
    try {
      return fileURLToPath(spec)
    } catch {
      return undefined
    }
  }
  if (path.isAbsolute(spec)) return spec
  if (spec.startsWith('.') || /^[A-Za-z]:[\\/]/.test(spec)) return path.resolve(anchors.profileDir, spec)
  return undefined
}

/**
 * @param {string} file - absolute path
 * @returns {Promise<object | undefined>} the parsed JSON object, when readable
 */
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * @param {string} target - candidate directory
 * @returns {Promise<boolean>} whether it exists and is a directory
 */
async function isDirectory(target) {
  const stat = await fsp.stat(target).catch(() => undefined)
  return stat !== undefined && stat.isDirectory()
}
