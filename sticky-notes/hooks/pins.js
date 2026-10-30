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

function shorten(text) {
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1).trimEnd() + '…' : text
}

// Splits text into checklist items. Returns null when there are fewer than two
// top-level items, because then it reads better as plain text.
function parseItems(text) {
  const items = []
  let inFence = false
  let lead = null
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    const last = items[items.length - 1]
    if (inFence) {
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
      })
      continue
    }
    // An indented line under an item explains that item
    if (last && /^\s+\S/.test(line)) last.detailLines.push(line.trim())
  }
  if (items.filter((i) => i.depth === 0).length < 2) return null
  return items.map(({ detailLines, ...item }) => {
    const detail = detailLines.join('\n').trim()
    return detail ? { ...item, detail } : item
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
    collapsed: false,
    createdAt,
  }
  if (source === 'message') pin.hash = hashText(text)
  return pin
}

export function toggleItem(pins, pinId, index) {
  return pins.map((p) =>
    p.id !== pinId || !p.items
      ? p
      : { ...p, items: p.items.map((it, i) => (i === index ? { ...it, done: !it.done } : it)) },
  )
}

export function toggleCollapsed(pins, pinId) {
  return pins.map((p) => (p.id === pinId ? { ...p, collapsed: !p.collapsed } : p))
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
