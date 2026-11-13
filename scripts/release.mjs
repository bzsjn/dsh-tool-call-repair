#!/usr/bin/env node
/**
 * Release a new version so the market can see it.
 *
 * The index pins every version to a 40-hex commit, so "update" means "publish a new
 * version": bump package.json, commit, tag, rebuild index.json, push. One command:
 *
 *   node scripts/release.mjs patch          # 0.4.2 -> 0.4.3
 *   node scripts/release.mjs minor          # 0.4.2 -> 0.5.0
 *   node scripts/release.mjs major          # 0.4.2 -> 1.0.0
 *   node scripts/release.mjs --set 1.2.3    # explicit version
 *   node scripts/release.mjs patch --no-push
 *
 * index.json is committed on purpose: index sources that read the branch
 * (jsDelivr `@main`, raw.githubusercontent `/main/`) only see the new version
 * once the file lands on main. GitHub Pages rebuilds from the tag push.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'package.json')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--no-push')
const argument = argv.find((value) => value !== '--no-push')

const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()
const run = (label, ...args) => {
  console.log(`> ${label}`)
  return git(...args)
}

function compare(left, right) {
  const parse = (text) => {
    const [core, pre = ''] = text.split('+')[0].split('-')
    return { core: core.split('.').map(Number), pre: pre === '' ? [] : pre.split('.') }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  return a.pre.join('.') === b.pre.join('.') ? 0 : a.pre.join('.') < b.pre.join('.') ? -1 : 1
}

function nextVersion(current, argument) {
  if (argument === '--set') {
    const explicit = argv[argv.indexOf('--set') + 1]
    if (!/^\d+\.\d+\.\d+$/u.test(explicit ?? '')) throw new Error('--set needs an exact x.y.z version')
    if (compare(explicit, current) <= 0) throw new Error(`--set must be greater than ${current}`)
    return explicit
  }
  const [major, minor, patch] = current.split('.').map(Number)
  if (argument === 'major') return `${major + 1}.0.0`
  if (argument === 'minor') return `${major}.${minor + 1}.0`
  if (argument === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error('usage: node scripts/release.mjs <patch|minor|major|--set x.y.z> [--no-push]')
}

const status = git('status', '--porcelain')
if (status !== '') throw new Error(`working tree is not clean:\n${status}`)

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const current = manifest.version
const version = nextVersion(current, argument)
const tag = `v${version}`
if (git('tag', '--list', tag) !== '') throw new Error(`${tag} already exists`)

manifest.version = version
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`${current} -> ${version}`)

run('commit version', 'add', 'package.json')
run('commit version', 'commit', '-m', `chore: release ${version}`)
run('tag', 'tag', '-a', tag, '-m', `release ${version}`)

run('rebuild index', 'add', 'index.json')
execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-index.mjs')], { cwd: ROOT, stdio: 'inherit' })
run('commit index', 'add', 'index.json')
run('commit index', 'commit', '-m', `chore: index ${version}`)

if (dryRun) {
  console.log('\n--no-push: commits and tag are local. Push manually:')
  console.log('  git push origin main --follow-tags')
} else {
  run('push', 'push', 'origin', 'main', '--follow-tags')
  console.log(`\nreleased ${version}. Index sources on main update within their TTL;`)
  console.log('GitHub Pages republishes from the tag push.')
}