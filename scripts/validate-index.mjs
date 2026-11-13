#!/usr/bin/env node
/**
 * Deep check: validate index.json with DSH's own format-1 validator, then print the
 * exact install spec the market will hand to pnpm.
 *
 * The validator ships inside a DSH installation, not on npm, so point at it explicitly:
 *
 *   DSH_PLUGIN_MARKET_INDEX="<app>/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js" \
 *     node scripts/validate-index.mjs
 *
 * Windows (PowerShell):
 *
 *   $env:DSH_PLUGIN_MARKET_INDEX = 'E:\...\resources\app\node_modules\@deepseek-ai\dsh-plugin-market-index\lib\index.js'
 *   node scripts/validate-index.mjs
 *
 * Optional: INDEX_URL overrides the URL relative icons resolve against.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_FILE = join(ROOT, 'index.json')
const INDEX_URL = process.env.INDEX_URL ?? 'https://bzsjn.github.io/dsh-tool-call-repair/index.json'
const VALIDATOR = process.env.DSH_PLUGIN_MARKET_INDEX

if (!VALIDATOR) {
  console.error('set DSH_PLUGIN_MARKET_INDEX to @deepseek-ai/dsh-plugin-market-index/lib/index.js')
  process.exit(2)
}

const { parseMarketIndex, marketInstallTarget, MarketIndexError } = await import(pathToFileURL(VALIDATOR).href)
const document = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))

try {
  const index = parseMarketIndex(document, INDEX_URL)
  console.log(`ok: format ${index.format} "${index.title.en}" — ${index.plugins.length} plugin(s)`)
  for (const plugin of index.plugins) {
    console.log(`  ${plugin.name}: ${plugin.versions.length} version(s)`)
    for (const version of plugin.versions) {
      const target = marketInstallTarget(plugin.name, version)
      console.log(`    ${version.version}  dsh ${version.engines.dsh ?? '(unbounded)'}  ${target.spec}`)
    }
    if (plugin.icon) console.log(`  icon: ${plugin.icon}`)
  }
} catch (error) {
  if (error instanceof MarketIndexError) {
    console.error(`invalid: ${error.path} ${error.reason}`)
    process.exit(1)
  }
  throw error
}