// sticky-notes: a sidebar of pinned messages, checklists and notes, kept per project.
import { makePin, toggleItem, toggleCollapsed, removePin, progress, hashText, parsePinArgs, parseUnpinArgs, splitBlocks, pinMarkdown, checklistMarkdown, pinCodes, stripInline } from './pins.js'

const PANE = 'sticky'

// The board for this session's project, mirrored from $.store
let storeKey = 'board:default'
let root = ''
let pins = []
let paneOpen = false

function newId() {
  return Math.random().toString(36).slice(2, 10)
}

async function loadBoard($) {
  const saved = await $.store.get(storeKey)
  pins = Array.isArray(saved?.pins) ? saved.pins : []
}

// Every session on the machine shares $.store, so re-read before each change
// to avoid writing over a pin another session just added.
async function mutate($, change) {
  await loadBoard($)
  pins = change(pins)
  await $.store.set(storeKey, { root, pins })
  $.ui.invalidate('ui.render')
}

async function openPane($, withFocus) {
  const pane = { id: PANE, title: 'Sticky notes', columns: 48 }
  const placed = await $.ui.open(withFocus ? { ...pane, focus: true } : pane)
  // A pane waiting for a wider terminal isn't showing, so /sticky should open it, not close it
  paneOpen = Boolean(placed?.isPlaced)
  return placed
}

async function addPin($, fields, withFocus) {
  const pin = makePin({ ...fields, id: newId(), createdAt: await $.clock.now() })
  await mutate($, (list) => [pin, ...list])
  const placed = await openPane($, withFocus)
  if (!placed?.isPlaced) $.ui.toast('📌 Pinned "' + pin.title + '" · run /sticky to see it')
  return pin
}

// The nth most recent message from Claude that has text, counting from 1
async function recentClaudeText($, n) {
  const messages = await $.session.messages()
  const replies = messages.filter((m) => m.role === 'assistant' && m.text && m.text.trim())
  return replies[replies.length - n]?.text
}

// Puts text on the clipboard of the surface that was pressed, and says how it went
async function copyText($, press, text, what) {
  try {
    const res = await $.ui.copy({ text, surface: press?.surface })
    $.ui.toast(res?.isCopied ? '⧉ Copied ' + what : 'Could not copy ' + what + (res?.reason ? ' (' + res.reason + ')' : ''))
  } catch (err) {
    $.ui.toast('Could not copy ' + what + ': ' + (err?.message ?? err))
  }
}

// Every command returns text: over Remote Control, an empty reply left Desktop stuck on "Stopping"
export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      root = (await $.session.root()) || (await $.session.cwd()) || ''
    } catch {
      root = ''
    }
    storeKey = 'board:' + (root ? hashText(root) : 'default')
    await loadBoard($)

    await $.tool.register({
      name: 'pin',
      description:
        "Pin text to the user's sticky-note sidebar so it stays visible while the conversation scrolls on. " +
        'Use it when you give the user step-by-step instructions, a checklist, or a plan they will work through ' +
        'while asking follow-up questions. Markdown lists become tickable checklist items. ' +
        "Don't pin short answers or things the user won't need to refer back to.",
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short title, a few words' },
          text: { type: 'string', description: 'The markdown to pin, usually the checklist itself' },
        },
        required: ['text'],
      },
      isDeferred: false,
    })

    const commands = [
      { name: 'pin', description: "Pin Claude's last message to the sticky sidebar (/pin 2 for the one before)", argumentHint: '[n] [title]' },
      { name: 'unpin', description: 'Remove a sticky note (/unpin 1 for the top one, /unpin all)', argumentHint: '[n|all]' },
      { name: 'note', description: 'Add your own sticky note', argumentHint: '<text>' },
      { name: 'sticky', description: 'Show or hide the sticky-note sidebar' },
    ]
    for (const command of commands) {
      try {
        await $.command.register({ ...command, immediate: true })
      } catch (err) {
        $.ui.log('could not add /' + command.name + ': ' + (err?.message ?? err))
      }
    }
    return next(e)
  })

  // /pin [n] [title]
  on('command.run', { command: 'pin' }, async ($, e) => {
    const { n, title } = parsePinArgs(e.args)
    const text = await recentClaudeText($, n)
    if (!text) {
      return { text: n === 1 ? 'No message from Claude to pin yet' : 'There is no message ' + n + ' back' }
    }
    const pin = await addPin($, { source: 'message', text, title }, false)
    return { text: 'Pinned "' + pin.title + '"' }
  })

  // /unpin [n|all]
  on('command.run', { command: 'unpin' }, async ($, e) => {
    const parsed = parseUnpinArgs(e.args)
    if (parsed.error) return { text: parsed.error }
    await loadBoard($)
    if (parsed.all) {
      await mutate($, () => [])
      return { text: 'Cleared all sticky notes' }
    }
    const target = pins[parsed.n - 1]
    if (!target) return { text: 'No sticky note there' }
    await mutate($, (list) => removePin(list, target.id))
    return { text: 'Unpinned "' + target.title + '"' }
  })

  // /note <text>
  on('command.run', { command: 'note' }, async ($, e) => {
    const text = String(e.args || '').trim()
    if (!text) {
      await openPane($, true)
      return { text: 'Sticky notes shown' }
    }
    const pin = await addPin($, { source: 'note', text }, false)
    return { text: 'Noted "' + pin.title + '"' }
  })

  // /sticky
  on('command.run', { command: 'sticky' }, async ($) => {
    if (paneOpen) {
      await $.ui.close({ id: PANE })
      paneOpen = false
      return { text: 'Sticky notes hidden' }
    }
    await loadBoard($)
    await openPane($, true)
    return { text: 'Sticky notes shown' }
  })

  // Claude pins something itself
  on('tool.call', { tool: 'mcp__sticky-notes__pin' }, async ($, e) => {
    const text = String(e.text || '').trim()
    if (!text) return { result: 'Nothing pinned: text was empty.' }
    const pin = await addPin($, { source: 'claude', text, title: e.title }, false)
    const count = pin.items ? pin.items.length + ' checklist items' : 'a note'
    return { result: 'Pinned "' + pin.title + '" (' + count + ") to the user's sticky sidebar." }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // A small marker on messages that are pinned
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = typeof e.props?.text === 'string' ? e.props.text : null
    if (!text || !pins.some((p) => p.hash && p.hash === hashText(text))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return Box({
      flexDirection: 'column',
      children: [theirs, Text({ dimColor: true, children: ['📌 pinned to sticky notes'] })],
    })
  })

  // The sidebar
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    // Pick up pins another session on this project added
    await loadBoard($)
    const { Box, Text, Button, Input, Markdown, Code } = $.ui.resolve(e)

    const header = Input({
      key: 'new-note',
      label: '✎',
      placeholder: 'Add a note and press Enter',
      value: '',
      submitLabel: 'add',
      onSubmit: async (value) => {
        if (!value.trim()) return
        const pin = makePin({ source: 'note', text: value.trim(), id: newId(), createdAt: await $.clock.now() })
        await mutate($, (list) => [pin, ...list])
      },
    })

    if (pins.length === 0) {
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          header,
          Text({ dimColor: true, children: ["Nothing pinned yet. Run /pin to pin Claude's last message, or /note <text>."] }),
        ],
      })
    }

    // Text that wraps inside a flexible cell instead of running off the pane
    const wrapped = (props, children) => Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, children: [Text({ wrap: 'wrap', ...props, children })] })

    const copyButton = (key, text, what, label = '⧉') =>
      Button({ key, label, plain: true, onPress: (press) => copyText($, press, text, what) })

    // A snippet with its copy button: a command, or a fenced block
    const snippet = (key, source, lang) =>
      Box({
        key,
        flexDirection: 'column',
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Box({ flexGrow: 1, children: [Text({ dimColor: true, children: [lang || 'code'] })] }),
              copyButton(key + '-copy', source, lang ? lang + ' snippet' : 'snippet', '⧉ copy'),
            ],
          }),
          Code({ source, ...(lang ? { language: lang } : {}), wrap: 'wrap' }),
        ],
      })

    // `command` chips: one line each, with a copy button. Past three they
    // would drown the note, so they fold into one "copy all" button.
    const chips = (key, codes) => {
      const oneLiners = codes.filter((c) => !c.includes('\n'))
      if (codes.length === 0) return []
      if (codes.length > 3) {
        return [copyButton(key + '-all', codes.join('\n'), codes.length + ' commands', '⧉ copy all ' + codes.length + ' commands')]
      }
      return codes.map((code, i) =>
        oneLiners.includes(code)
          ? Box({
              key: key + '-chip-' + i,
              flexDirection: 'row',
              columnGap: 1,
              children: [copyButton(key + '-chip-copy-' + i, code, 'command'), wrapped({ color: 'cyan' }, [code])],
            })
          : snippet(key + '-chip-' + i, code),
      )
    }

    const cellText = (cell) => stripInline(cell)

    // A table drawn as a grid: bold header, rule under it, cells that wrap,
    // and a lone `code` cell is a copy button
    const table = (key, t) => {
      const cols = Math.max(t.header.length, ...t.rows.map((r) => r.length))
      const width = Math.floor(100 / cols) + '%'
      const row = (cells, ri, head) =>
        Box({
          key: key + '-r' + ri,
          flexDirection: 'row',
          columnGap: 1,
          ...(head ? { borderStyle: 'single', borderColor: 'gray' } : {}),
          children: Array.from({ length: cols }, (_, ci) => {
            const cell = cells[ci] ?? ''
            const lone = /^`([^`]+)`$/.exec(cell.trim())
            const align = t.aligns[ci] === 'right' ? 'flex-end' : t.aligns[ci] === 'center' ? 'center' : 'flex-start'
            const inner = lone
              ? Button({ key: key + '-c' + ri + '-' + ci, label: lone[1], plain: true, onPress: (press) => copyText($, press, lone[1], 'cell') })
              : Text({ bold: head, wrap: 'wrap', children: [cellText(cell)] })
            return Box({ key: key + '-b' + ri + '-' + ci, width, minWidth: 0, flexShrink: 1, justifyContent: align, children: [inner] })
          }),
        })
      return Box({
        key,
        flexDirection: 'column',
        children: [
          Box({
            flexDirection: 'row',
            children: [
              Box({ flexGrow: 1, children: [Text({ dimColor: true, children: ['table · ' + t.rows.length + ' rows'] })] }),
              copyButton(key + '-copy', t.source, 'table', '⧉ copy table'),
            ],
          }),
          row(t.header, 0, true),
          ...t.rows.map((r, ri) => row(r, ri + 1, false)),
        ],
      })
    }

    // A pinned message that isn't a checklist: prose, code and tables each in their own way
    const bodyBlocks = (pin) => {
      const segments = splitBlocks(pin.body)
      return segments.flatMap((seg, si) => {
        const key = 'seg-' + pin.id + '-' + si
        if (seg.kind === 'code') return [snippet(key, seg.source, seg.lang)]
        if (seg.kind === 'table') return [table(key, seg)]
        return [Markdown({ key, text: seg.text }), ...chips(key, [...new Set(seg.text.match(/(?<!`)`[^`\n]+`(?!`)/g)?.map((c) => c.slice(1, -1).trim()) ?? [])])]
      })
    }

    const card = (pin, n) => {
      const done = progress(pin)
      const mark = pin.source === 'note' ? '✎' : pin.source === 'claude' ? '✦' : '📌'
      const top = Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          wrapped({ bold: true }, [n + ' ' + mark + ' ' + pin.title]),
          ...(done ? [Text({ ...(done.done === done.total ? { color: 'green' } : { dimColor: true }), children: [done.done + '/' + done.total] })] : []),
          copyButton('copy-' + pin.id, pin.items ? checklistMarkdown(pin) : pinMarkdown(pin), 'note'),
          Button({
            key: 'fold-' + pin.id,
            label: pin.collapsed ? '▸' : '▾',
            plain: true,
            onPress: () => mutate($, (list) => toggleCollapsed(list, pin.id)),
          }),
          Button({
            key: 'unpin-' + pin.id,
            label: '✕',
            plain: true,
            onPress: () => mutate($, (list) => removePin(list, pin.id)),
          }),
        ],
      })
      if (pin.collapsed) return Box({ key: 'pin-' + pin.id, borderStyle: 'round', paddingX: 1, children: [top] })

      const body = pin.items
        ? pin.items.flatMap((item, i) => {
            const rowKey = pin.id + '-' + i
            return [
              Box({
                key: 'row-' + rowKey,
                paddingLeft: item.depth * 2,
                flexDirection: 'row',
                columnGap: 1,
                children: [
                  Box({
                    flexGrow: 1,
                    flexShrink: 1,
                    minWidth: 0,
                    children: [
                      Button({
                        key: 'item-' + rowKey,
                        plain: true,
                        children: [Text({ wrap: 'wrap', dimColor: item.done, strikethrough: item.done, children: [(item.done ? '☑ ' : '☐ ') + item.text] })],
                        onPress: () => mutate($, (list) => toggleItem(list, pin.id, i)),
                      }),
                    ],
                  }),
                ],
              }),
              ...(!item.done && (item.detail || item.codes)
                ? [
                    Box({
                      key: 'detail-' + rowKey,
                      paddingLeft: item.depth * 2 + 2,
                      flexDirection: 'column',
                      children: [
                        // A detail made only of code is shown by the snippets below, not twice
                        ...(item.detail && !item.codes ? [Text({ dimColor: true, wrap: 'wrap', children: [item.detail] })] : []),
                        ...chips('chip-' + rowKey, item.codes || []),
                      ],
                    }),
                  ]
                : []),
            ]
          })
        : pin.body
          ? bodyBlocks(pin)
          : []

      const codes = pinCodes(pin)
      const footer = pin.items && codes.length > 3 ? [copyButton('copyall-' + pin.id, codes.join('\n'), codes.length + ' commands', '⧉ copy all ' + codes.length + ' commands')] : []

      return Box({
        key: 'pin-' + pin.id,
        flexDirection: 'column',
        borderStyle: 'round',
        ...(pin.source === 'note' ? { borderColor: 'yellow' } : {}),
        paddingX: 1,
        children: [top, ...body, ...footer],
      })
    }

    return Box({
      flexDirection: 'column',
      width: '100%',
      minWidth: 0,
      children: [header, ...pins.map((pin, i) => card(pin, i + 1))],
    })
  })
}
