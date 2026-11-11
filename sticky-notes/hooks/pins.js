// Pure logic for sticky notes: turning text into a pin, and changing pins.
// No mods API in here, so it can be tested with plain Node.

const TITLE_MAX = 60
// "- x", "* x", "+ x", "1. x", "1) x", with an optional "[ ]" / "[x]" task box
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*\S)\s*$/
const FENCE = /^\s*(```|~~~)/
const HEADING = /^\s*#{1,6}\s+(.*\S)/

export function stripInline(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim()
}

// The `inline code` spans of a line: what's worth a copy button
export function inlineCodes(text) {
  const codes = []
  for (const m of String(text).matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)) {
    const code = m[2].trim()
    if (code) codes.push(code)
  }
  return codes
}

function shorten(text) {
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1).trimEnd() + '…' : text
}

// Splits text into checklist items. Returns null when there are fewer than two
// top-level items, because then it reads better as plain text.
function parseItems(text) {
  const items = []
  let inFence = false
  let fenceLines = []
  let lead = null
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      const closing = inFence
      inFence = !inFence
      const owner = items[items.length - 1]
      if (closing && owner && fenceLines.length) owner.codes.push(fenceLines.join('\n'))
      fenceLines = []
      continue
    }
    const last = items[items.length - 1]
    if (inFence) {
      fenceLines.push(line)
      if (last) last.detailLines.push(line)
      continue
    }
    const m = ITEM.exec(line)
    if (m) {
      if (lead === null) lead = m[1].length
      const indent = m[1].length
      items.push({
        text: stripInline(m[3]),
        done: m[2] === 'x' || m[2] === 'X',
        depth: indent > lead ? 1 : 0,
        detailLines: [],
        codes: inlineCodes(m[3]),
      })
      continue
    }
    // An indented line under an item explains that item
    if (last && /^\s+\S/.test(line)) {
      last.detailLines.push(line.trim())
      last.codes.push(...inlineCodes(line))
    }
  }
  if (items.filter((i) => i.depth === 0).length < 2) return null
  return items.map(({ detailLines, codes, ...item }) => {
    const detail = detailLines.join('\n').trim()
    const withCodes = codes.length ? { ...item, codes: [...new Set(codes)] } : item
    return detail ? { ...withCodes, detail } : withCodes
  })
}

function titleFrom(text) {
  const lines = text.split('\n')
  for (const line of lines) {
    const m = HEADING.exec(line)
    if (m) return stripInline(m[1])
  }
  for (const line of lines) {
    if (line.trim() && !ITEM.test(line) && !FENCE.test(line)) return stripInline(line)
  }
  return ''
}

// source: 'message' (pinned from the conversation), 'claude' (Claude pinned it),
// or 'note' (typed by the user)
export function makePin({ id, source, text, title, createdAt = 0 }) {
  const items = parseItems(text)
  const body = items ? null : text.trim()
  const pinTitle = shorten(stripInline(title || '') || titleFrom(text) || 'Pinned message')
  const pin = {
    id,
    source,
    title: pinTitle,
    items,
    // A one-line text is already its title, so don't draw it twice
    body: body && stripInline(body) !== pinTitle ? body : null,
    // The markdown as it was pinned, so a note can be copied back out whole
    raw: text.trim(),
    collapsed: false,
    createdAt,
  }
  if (source === 'message') pin.hash = hashText(text)
  return pin
}

// Claude re-pinning a note under the same title updates that note instead of
// stacking a copy: it keeps its id, place and view state, and an item stays
// ticked if the user ticked it by hand (matched by its text).
export function upsertClaudePin(pins, fresh) {
  const key = (t) => String(t || '').trim().toLowerCase()
  const at = pins.findIndex((p) => p.source === 'claude' && key(p.title) === key(fresh.title))
  if (at === -1) return { pins: [fresh, ...pins], replaced: false }
  const old = pins[at]
  const doneBefore = new Set((old.items || []).filter((i) => i.done).map((i) => i.text))
  const items = fresh.items && fresh.items.map((i) => (doneBefore.has(i.text) ? { ...i, done: true } : i))
  const next = { ...fresh, items, id: old.id, collapsed: old.collapsed, createdAt: old.createdAt }
  if (old.hideDone !== undefined) next.hideDone = old.hideDone
  return { pins: pins.map((p, i) => (i === at ? next : p)), replaced: true }
}

export function toggleItem(pins, pinId, index) {
  return pins.map((p) =>
    p.id !== pinId || !p.items ? p : withItems(p, p.items.map((it, i) => (i === index ? { ...it, done: !it.done } : it))),
  )
}

// With nothing ticked there is no "N done" toggle, so the fold resets: a
// later tick would otherwise vanish with no toggle to explain it
function withItems(pin, items) {
  const next = { ...pin, items }
  if (next.hideDone && !items.some((it) => it.done)) next.hideDone = false
  return next
}

export function toggleCollapsed(pins, pinId) {
  return pins.map((p) => (p.id === pinId ? { ...p, collapsed: !p.collapsed } : p))
}

// Folds a checklist's ticked items behind a "N done" toggle, or shows them again
export function toggleHideDone(pins, pinId) {
  return pins.map((p) => (p.id === pinId ? { ...p, hideDone: !p.hideDone } : p))
}

// "just now", "5m ago", "3h ago", "2d ago"; '' when the pin has no time
export function ago(createdAt, now) {
  if (!createdAt) return ''
  const mins = Math.floor(Math.max(0, now - createdAt) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return mins + 'm ago'
  const hours = Math.floor(mins / 60)
  if (hours < 24) return hours + 'h ago'
  return Math.floor(hours / 24) + 'd ago'
}

const KIND = { claude: 'claude', message: 'pinned', note: 'note' }

// A card's meta line: the kind word first (drawn in its color), then the facts
// joined by " · "
export function pinMeta(pin, now) {
  const done = progress(pin)
  const codes = pinCodes(pin).length
  const facts = []
  if (done) facts.push(done.done + '/' + done.total + ' done')
  if (codes) facts.push(codes + (codes === 1 ? ' command' : ' commands'))
  const age = ago(pin.createdAt, now)
  if (age) facts.push(age)
  return { kind: KIND[pin.source] || 'pinned', isComplete: Boolean(done && done.done === done.total), facts }
}

export function removePin(pins, pinId) {
  return pins.filter((p) => p.id !== pinId)
}

export function progress(pin) {
  if (!pin.items) return null
  return { done: pin.items.filter((i) => i.done).length, total: pin.items.length }
}

// A short, stable fingerprint of a message's text, to recognise it when it's drawn
export function hashText(text) {
  const s = String(text).trim()
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36) + ':' + s.length
}

// "/pin", "/pin 2", "/pin 2 Deploy steps", "/pin Deploy steps".
// A number counts only as a word of its own, so "3rd step" is a title.
export function parsePinArgs(args) {
  const text = String(args || '').trim()
  const m = /^(\d+)(?:\s+|$)(.*)$/s.exec(text)
  if (m && Number(m[1]) > 0) return { n: Number(m[1]), title: m[2].trim() }
  return { n: 1, title: text }
}

// "/unpin", "/unpin 3", "/unpin all". Anything else is an error, so a typo
// never removes a note.
export function parseUnpinArgs(args) {
  const text = String(args || '').trim()
  if (!text) return { n: 1 }
  if (text === 'all') return { all: true }
  if (/^\d+$/.test(text) && Number(text) > 0) return { n: Number(text) }
  return { error: 'Use /unpin, /unpin <number>, or /unpin all' }
}

// What "copy this note" puts on the clipboard: the markdown as pinned, or for
// notes saved before `raw` existed, the checklist rebuilt from its items.
export function pinMarkdown(pin) {
  if (pin.raw) return pin.raw
  if (pin.items) {
    const lines = pin.items.map((i) => '  '.repeat(i.depth) + '- [' + (i.done ? 'x' : ' ') + '] ' + i.text)
    return lines.join('\n')
  }
  return pin.body || pin.title
}

// The checklist as markdown with the current ticks
export function checklistMarkdown(pin) {
  if (!pin.items) return pinMarkdown(pin)
  return pin.items.map((i) => '  '.repeat(i.depth) + '- [' + (i.done ? 'x' : ' ') + '] ' + i.text).join('\n')
}

// Every code snippet in a pin, in reading order, for "copy all commands"
export function pinCodes(pin) {
  if (pin.items) return [...new Set(pin.items.flatMap((i) => i.codes || []))]
  const codes = []
  for (const seg of splitBlocks(pin.body || '')) {
    if (seg.kind === 'code') codes.push(seg.source)
    else if (seg.kind === 'text') codes.push(...inlineCodes(seg.text))
  }
  return [...new Set(codes)]
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitRow(line) {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

// Cuts a markdown body into prose, fenced code and tables, so each can be
// drawn (and copied) in the way that suits it.
export function splitBlocks(text) {
  const lines = String(text).split('\n')
  const out = []
  let prose = []
  const flush = () => {
    const t = prose.join('\n').trim()
    if (t) out.push({ kind: 'text', text: t })
    prose = []
  }
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i])
    if (fence) {
      flush()
      const lang = lines[i].replace(/^\s*(```|~~~)\s*/, '').trim()
      const src = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) src.push(lines[i++])
      out.push({ kind: 'code', lang, source: src.join('\n') })
      continue
    }
    if (lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush()
      const start = i
      const header = splitRow(lines[i])
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'))
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]))
      i--
      out.push({ kind: 'table', header, aligns, rows, source: lines.slice(start, i + 1).join('\n') })
      continue
    }
    prose.push(lines[i])
  }
  flush()
  return out
}
