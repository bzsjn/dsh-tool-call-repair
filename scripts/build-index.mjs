#!/usr/bin/env node
/**
 * Build `index.json` — DSH plugin market index format 1 — for this repository.
 *
 * The document is the file DSH's plugin market reads when a user adds
 * `https://<owner>.github.io/<repo>/index.json` as an index source:
 * "发现 → 添加索引源". Every version listed here installs as a commit-pinned
 * `git+https` spec, so what the market shows is exactly what pnpm fetches.
 *
 * Rules implemented (mirrors @deepseek-ai/dsh-plugin-market-index):
 *   - `format` must be 1, `title` must carry `en`
 *   - plugin `name` must be a valid npm package name, unique in the index
 *   - `versions` non-empty, exact SemVer, no duplicates, newest first
 *   - git `source.url` canonical https, `source.commit` lowercase 40-hex
 *   - `publishTimestamp` integer Unix seconds
 *   - relative `icon` resolves against the index URL
 *   - `metadata.category` must be declared in the index `metadata.categories`
 *
 * Usage:
 *   node scripts/build-index.mjs            # write index.json
 *   node scripts/build-index.mjs --check    # validate the existing index.json
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'index.json')

/** Index-level display fields. `en` is mandatory, `zh` is what the UI shows in Chinese. */
const INDEX_TITLE = { en: 'BZSJN DSH plugins', zh: 'BZSJN DSH 插件源' }
const INDEX_DESCRIPTION = {
  en: 'Verified DSH bundles published from github.com/bzsjn: recoverable model-request retry and stream repair.',
  zh: '来自 github.com/bzsjn 的已校验 DSH 插件：模型请求可恢复故障重试与流式修复。',
}
/** Accepted DSH version range for every published version. */
const DSH_ENGINES = '>=0.2.1-rc.1 <0.3.0'
/** Declared taxonomy; ids referenced by plugins must exist here. */
const CATEGORIES = { reliability: { title: { en: 'Reliability', zh: '稳定性' } } }
const DEFAULT_CATEGORY = 'reliability'

const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Canonical repository URL: https, no credentials, no query/fragment, no `.git` suffix. */
function repositoryUrl(pkg) {
  const declared = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  // Fall back to the clone's origin so a missing package.json field cannot block publishing.
  const raw = declared ?? git('remote', 'get-url', 'origin')
  const url = new URL(String(raw).replace(/^git\+/, ''))
  url.search = ''
  url.hash = ''
  url.username = ''
  url.password = ''
  url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\.git$/iu, '')
  const canonical = `${url.origin}${url.pathname}`
  if (!/^(https?):\/\//u.test(canonical)) throw new Error(`repository.url must be http(s): ${raw}`)
  if (url.pathname.split('/').filter(Boolean).length < 2) {
    throw new Error(`repository.url must name a repository with at least two path segments: ${raw}`)
  }
  return canonical
}

/** `v1.2.3` / `1.2.3` tags → { version: { commit, timestamp } }. */
function taggedVersions() {
  const found = new Map()
  for (const tag of git('tag', '--list').split(/\r?\n/u).filter(Boolean)) {
    const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(tag)
    if (!match) continue
    const commit = git('rev-list', '-n', '1', `refs/tags/${tag}`)
    const timestamp = Number(git('log', '-1', '--format=%ct', commit))
    found.set(match[1], { commit, timestamp })
  }
  return found
}

function parseVersion(text) {
  const [core, pre = ''] = text.split('+')[0].split('-')
  const [major, minor, patch] = core.split('.').map(Number)
  return { major, minor, patch, pre: pre === '' ? [] : pre.split('.') }
}

/** SemVer precedence, enough to order the versions of one plugin. */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/u.test(x)
    const yNumeric = /^\d+$/u.test(y)
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (xNumeric) return -1
    else if (yNumeric) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Localized display text pulled from package.json, falling back to the English description. */
function localizedDescription(pkg) {
  const zh = typeof pkg.descriptionZh === 'string' && pkg.descriptionZh.trim() !== '' ? pkg.descriptionZh : undefined
  const en = typeof pkg.description === 'string' && pkg.description.trim() !== '' ? pkg.description : pkg.name
  return zh === undefined ? { en } : { en, zh }
}

function buildIndex() {
  const pkg = readJson(join(ROOT, 'package.json'))
  const repoUrl = repositoryUrl(pkg)
  const tagged = taggedVersions()

  if (!tagged.has(pkg.version)) {
    // An untagged release is still installable: pin it to HEAD.
    tagged.set(pkg.version, { commit: git('rev-parse', 'HEAD'), timestamp: Number(git('log', '-1', '--format=%ct')) })
  }

  const iconFile = typeof pkg.icon === 'string' ? pkg.icon.replace(/^\.\//u, '') : undefined
  const icon = iconFile !== undefined && existsSync(join(ROOT, iconFile)) ? iconFile : undefined

  const versions = [...tagged.entries()]
    .sort(([left], [right]) => compareVersions(right, left))
    .map(([version, { commit, timestamp }]) => ({
      version,
      publishTimestamp: timestamp,
      source: { type: 'git', url: repoUrl, commit },
      engines: { dsh: DSH_ENGINES },
    }))

  return {
    format: 1,
    title: INDEX_TITLE,
    description: INDEX_DESCRIPTION,
    metadata: {
      categories: CATEGORIES,
      labels: {},
      sortKeys: {},
    },
    plugins: [
      {
        name: pkg.name,
        title: { en: pkg.name, zh: pkg.name },
        description: localizedDescription(pkg),
        ...(icon === undefined ? {} : { icon }),
        ...(typeof pkg.author === 'string' ? { author: pkg.author } : {}),
        homepage: `${repoUrl}#readme`,
        repository: { url: repoUrl },
        metadata: {
          category: DEFAULT_CATEGORY,
          keywords: Array.isArray(pkg.keywords) ? pkg.keywords.filter((word) => typeof word === 'string') : [],
          labels: [],
          sortKeys: {},
        },
        versions,
      },
    ],
  }
}

/** Independent re-check of the rules the DSH reader enforces, so CI fails before publishing. */
function selfCheck(index) {
  const problems = []
  const fail = (path, reason) => problems.push(`${path} ${reason}`)

  if (index.format !== 1) fail('$.format', 'must be 1')
  if (typeof index.title?.en !== 'string' || index.title.en.trim() === '') fail('$.title.en', 'must be a string')
  if (!Array.isArray(index.plugins) || index.plugins.length === 0) fail('$.plugins', 'must be a non-empty array')

  const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
  const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u

  for (const [position, plugin] of index.plugins.entries()) {
    const at = `$.plugins[${position}]`
    if (!packageName.test(plugin.name)) fail(`${at}.name`, 'must be a valid npm package name')
    if (plugin.metadata?.category !== undefined && index.metadata?.categories?.[plugin.metadata.category] === undefined) {
      fail(`${at}.metadata.category`, `references undeclared category ${plugin.metadata.category}`)
    }
    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) fail(`${at}.versions`, 'must be non-empty')
    const seen = new Set()
    for (const [index_, version] of (plugin.versions ?? []).entries()) {
      const path = `${at}.versions[${index_}]`
      if (!semver.test(version.version)) fail(`${path}.version`, 'must be an exact SemVer version')
      if (seen.has(version.version)) fail(`${path}.version`, 'duplicates a version')
      seen.add(version.version)
      if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp < 0 || version.publishTimestamp >= 1e11) {
        fail(`${path}.publishTimestamp`, 'must be integer Unix seconds in [0, 10^11)')
      }
      if (version.source?.type !== 'git' && version.source?.type !== 'npm') fail(`${path}.source.type`, 'must be git or npm')
      if (version.source?.type === 'git') {
        if (!/^[0-9a-f]{40}$/u.test(version.source.commit ?? '')) fail(`${path}.source.commit`, 'must be a 40-hex commit')
        let url
        try {
          url = new URL(version.source.url)
        } catch {
          fail(`${path}.source.url`, 'must be an absolute URL')
        }
        if (url && (url.protocol !== 'https:' || url.href !== version.source.url)) {
          fail(`${path}.source.url`, 'must be a canonical https URL')
        }
      }
      const range = version.engines?.dsh
      if (range !== undefined && (typeof range !== 'string' || range.startsWith('workspace:'))) {
        fail(`${path}.engines.dsh`, 'must be a SemVer range')
      }
    }
  }
  return problems
}

if (process.argv.includes('--check')) {
  const problems = selfCheck(readJson(OUTPUT))
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log('index.json passes format-1 self-check')
} else {
  const index = buildIndex()
  const problems = selfCheck(index)
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  writeFileSync(OUTPUT, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  const [plugin] = index.plugins
  const [latest] = plugin.versions
  console.log(`index.json: ${plugin.name} ${plugin.versions.length} version(s), newest ${latest.version}`)
  console.log(`install spec: git+${latest.source.url}.git#${latest.source.commit}`)
}