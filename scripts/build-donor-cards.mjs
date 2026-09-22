#!/usr/bin/env node
// Builds the README's donor row: one SVG card per donor (round avatar, handle
// underneath) in a light and a dark variant, plus a closing "Become a donor"
// card that links to GitHub Sponsors.
//
// GitHub strips `style` from README HTML, so a round avatar cannot come from CSS,
// and a table would add cell borders. The cards carry the avatar as an embedded
// data URI because an SVG rendered as an image cannot load external resources.
// The avatars are therefore a snapshot: rerun this script to refresh them.
//
// Usage: add the GitHub handle to docs/assets/donors/donors.json (the order there
// is the display order), then run:
//
//   node scripts/build-donor-cards.mjs

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSET_DIR = 'docs/assets/donors'
const LIST_PATH = join(ROOT, ASSET_DIR, 'donors.json')
const README_PATH = join(ROOT, 'README.md')
const SPONSORS_URL = 'https://github.com/sponsors/mugar123'
const START = '<!-- donors:start -->'
const END = '<!-- donors:end -->'

const AVATAR = 64
const AVATAR_TOP = 4
const LABEL_GAP = 22
const FONT_SIZE = 13
const HEIGHT = AVATAR_TOP + AVATAR + LABEL_GAP + 6
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"
const CTA_LABEL = 'Become a donor'

// GitHub's own foreground, muted and border colours for each theme.
const THEMES = {
  light: { fg: '#1f2328', muted: '#59636e', ring: '#d1d9e0' },
  dark: { fg: '#f0f6fc', muted: '#9198a1', ring: '#3d444d' },
}

const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

const escapeXml = (text) =>
  text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

// SVG text cannot be measured here, so the width is a generous estimate for a
// 13 px semibold system font. Every card shares the widest one so the row reads
// as a grid.
const cardWidth = (labels) =>
  Math.max(112, ...labels.map((label) => Math.ceil(label.length * 7.6) + 24))

async function fetchAvatar(handle) {
  const response = await fetch(`https://github.com/${handle}.png?size=${AVATAR * 2}`)
  if (!response.ok) throw new Error(`Avatar for ${handle}: HTTP ${response.status}`)
  const type = response.headers.get('content-type')?.split(';')[0] ?? ''
  if (!type.startsWith('image/')) throw new Error(`Avatar for ${handle}: unexpected ${type}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  return `data:${type};base64,${bytes.toString('base64')}`
}

function svgFrame(width, title, body) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}">`,
    `  <title>${escapeXml(title)}</title>`,
    body,
    '</svg>',
    '',
  ].join('\n')
}

function labelText(width, label, fill) {
  const baseline = AVATAR_TOP + AVATAR + LABEL_GAP
  return `  <text x="${width / 2}" y="${baseline}" text-anchor="middle" font-family="${FONT_STACK}" font-size="${FONT_SIZE}" font-weight="600" fill="${fill}">${escapeXml(label)}</text>`
}

function donorCard(width, handle, avatarUri, theme) {
  const cx = width / 2
  const cy = AVATAR_TOP + AVATAR / 2
  const r = AVATAR / 2
  return svgFrame(width, handle, [
    '  <defs>',
    `    <clipPath id="avatar"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>`,
    '  </defs>',
    `  <image href="${avatarUri}" x="${cx - r}" y="${AVATAR_TOP}" width="${AVATAR}" height="${AVATAR}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)"/>`,
    `  <circle cx="${cx}" cy="${cy}" r="${r - 0.5}" fill="none" stroke="${theme.ring}" stroke-width="1"/>`,
    labelText(width, handle, theme.fg),
  ].join('\n'))
}

function ctaCard(width, theme) {
  const cx = width / 2
  const cy = AVATAR_TOP + AVATAR / 2
  const r = AVATAR / 2
  const arm = 9
  return svgFrame(width, CTA_LABEL, [
    `  <circle cx="${cx}" cy="${cy}" r="${r - 0.75}" fill="none" stroke="${theme.muted}" stroke-width="1.5" stroke-dasharray="4 4"/>`,
    `  <path d="M${cx - arm} ${cy}H${cx + arm}M${cx} ${cy - arm}V${cy + arm}" stroke="${theme.muted}" stroke-width="1.5" stroke-linecap="round"/>`,
    labelText(width, CTA_LABEL, theme.muted),
  ].join('\n'))
}

function pictureLink(href, title, base, width, alt) {
  const src = (theme) => `${ASSET_DIR}/${base}-${theme}.svg`
  return (
    `  <a href="${href}" title="${escapeXml(title)}"><picture>` +
    `<source media="(prefers-color-scheme: dark)" srcset="${src('dark')}">` +
    `<img src="${src('light')}" width="${width}" height="${HEIGHT}" alt="${escapeXml(alt)}">` +
    '</picture></a>'
  )
}

const donors = JSON.parse(await readFile(LIST_PATH, 'utf8'))
if (!Array.isArray(donors) || donors.length === 0) throw new Error('donors.json must be a non-empty array')
for (const handle of donors) {
  if (typeof handle !== 'string' || !HANDLE.test(handle)) throw new Error(`Not a GitHub handle: ${handle}`)
}
const seen = new Set()
for (const handle of donors) {
  const key = handle.toLowerCase()
  if (seen.has(key)) throw new Error(`Listed twice: ${handle}`)
  seen.add(key)
}

const width = cardWidth([...donors, CTA_LABEL])
const avatars = await Promise.all(donors.map(fetchAvatar))

// Clear the previous cards so a removed donor does not leave files behind.
const assetPath = join(ROOT, ASSET_DIR)
await mkdir(assetPath, { recursive: true })
for (const file of await readdir(assetPath)) {
  if (file.endsWith('.svg')) await rm(join(assetPath, file))
}

const links = []
for (const [index, handle] of donors.entries()) {
  const base = handle.toLowerCase()
  for (const [name, theme] of Object.entries(THEMES)) {
    await writeFile(join(assetPath, `${base}-${name}.svg`), donorCard(width, handle, avatars[index], theme))
  }
  links.push(pictureLink(`https://github.com/${handle}`, handle, base, width, handle))
}
for (const [name, theme] of Object.entries(THEMES)) {
  await writeFile(join(assetPath, `become-a-donor-${name}.svg`), ctaCard(width, theme))
}
links.push(pictureLink(SPONSORS_URL, 'Support PaperTok on GitHub Sponsors', 'become-a-donor', width, 'Become a donor on GitHub Sponsors'))

const readme = await readFile(README_PATH, 'utf8')
const start = readme.indexOf(START)
const end = readme.indexOf(END)
if (start === -1 || end === -1 || end < start) throw new Error(`README.md needs ${START} … ${END} markers`)
const block = `${START}\n<p align="center">\n${links.join('\n')}\n</p>\n${END}`
await writeFile(README_PATH, readme.slice(0, start) + block + readme.slice(end + END.length))

console.log(`Wrote ${donors.length} donor cards (${width} px wide) and updated README.md`)
