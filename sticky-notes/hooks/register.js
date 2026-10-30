// sticky-notes: a sidebar of pinned messages, checklists and notes, kept per project.
import { makePin, toggleItem, toggleCollapsed, removePin, progress, hashText, parsePinArgs, parseUnpinArgs } from './pins.js'

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
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)

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

    const card = (pin, n) => {
      const done = progress(pin)
      const mark = pin.source === 'note' ? '✎' : pin.source === 'claude' ? '✦' : '📌'
      const top = Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Box({
            flexGrow: 1,
            children: [Text({ bold: true, children: [n + ' ' + mark + ' ' + pin.title] })],
          }),
          ...(done ? [Text({ ...(done.done === done.total ? { color: 'green' } : { dimColor: true }), children: [done.done + '/' + done.total] })] : []),
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
        ? pin.items.flatMap((item, i) => [
            Box({
              key: 'row-' + pin.id + '-' + i,
              paddingLeft: item.depth * 2,
              children: [
                Button({
                  key: 'item-' + pin.id + '-' + i,
                  label: (item.done ? '☑ ' : '☐ ') + item.text,
                  plain: true,
                  dimColor: item.done,
                  onPress: () => mutate($, (list) => toggleItem(list, pin.id, i)),
                }),
              ],
            }),
            ...(item.detail && !item.done
              ? [Box({ key: 'detail-' + pin.id + '-' + i, paddingLeft: item.depth * 2 + 2, children: [Text({ dimColor: true, children: [item.detail] })] })]
              : []),
          ])
        : pin.body
          ? [Markdown({ key: 'md-' + pin.id, text: pin.body })]
          : []

      return Box({
        key: 'pin-' + pin.id,
        flexDirection: 'column',
        borderStyle: 'round',
        ...(pin.source === 'note' ? { borderColor: 'yellow' } : {}),
        paddingX: 1,
        children: [top, ...body],
      })
    }

    return Box({
      flexDirection: 'column',
      children: [header, ...pins.map((pin, i) => card(pin, i + 1))],
    })
  })
}
