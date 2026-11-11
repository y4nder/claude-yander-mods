import { expect, test } from 'claude-code/testing'
import { makePin } from '../hooks/pins.js'

const PANE = {
  plugin: 'sticky-notes',
  component: 'Pane',
  requestId: 'sticky',
  props: { title: 'Sticky notes', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const checklist = makePin({ id: 'a', source: 'claude', createdAt: 1, text: '## Setup\n1. Run `npm install` then `npm test`\n2. A very long second step that must wrap instead of being clipped at the pane edge\n   ```bash\n   git push\n   ```' })
const message = makePin({ id: 'b', source: 'message', text: 'Intro\n\n| Name | Cmd |\n| --- | --- |\n| one | `ls -la` |\n\n```sh\nls\n```' })

// A board in memory, so a tick is saved and read back
async function start($: any, on: any) {
  let board: unknown = { pins: [checklist, message] }
  on('store.get', () => ({ value: board }))
  on('store.set', (_: unknown, e: { value: unknown }) => {
    board = e.value
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.register', () => ({ value: {} }))
  on('clock.now', () => ({ value: 1 + 5 * 60_000 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

test('the sidebar draws copy buttons, snippets and tables on desktop and terminal', async ($, on) => {
  await start($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'copy-a' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'chip-a-0-chip-copy-0' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'seg-b-1-c1-1' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /one/ })).toBeTruthy()
    // Title line, then the meta line led by the kind word
    expect(await ui.find({ type: 'Text', text: /^1\. Setup$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^claude$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /0\/2 done/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Pinned · 2$/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('the terminal draws ASCII checkboxes; the desktop draws Svg boxes under a click layer', async ($, on) => {
  await start($, on)
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /^\[ \] Run npm install/ })).toBeTruthy()
  expect(await term.findAll({ type: 'Svg' })).toHaveLength(0)
  await term.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const boxes = await desk.findAll({ type: 'Svg' })
  expect(boxes.length).toBe(2)
  expect(boxes.every((b) => typeof b.props.alt === 'string' && b.props.alt.length > 0)).toBe(true)
  const hits = (await desk.findAll({ type: 'Client' })).map((c) => c.key)
  expect(hits).toEqual(['hit-a-0', 'hit-a-1'])
  // The row's own Text keeps its styles: no Button around it
  expect(await desk.find({ type: 'Button', key: 'item-a-0' })).toBeFalsy()
  await desk.unmount()
})

test('clicking a desktop row ticks it, and ticked items fold behind "N done"', async ($, on) => {
  await start($, on)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'hit-a-0' })
  await desk.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-a-0' })
  const ticked = (await desk.findAll({ type: 'Text' })).find((t) => t.text === 'Run npm install then npm test')
  expect(ticked?.props.strikethrough).toBe(true)
  expect(await desk.find({ type: 'Text', text: /1\/2 done/ })).toBeTruthy()

  await desk.press({ key: 'done-a' })
  expect((await desk.findAll({ type: 'Client' })).map((c) => c.key)).toEqual(['hit-a-1'])
  expect((await desk.find({ type: 'Button', key: 'done-a' }))?.props.label).toBe('▸ 1 done')
  await desk.unmount()
})

test('hidden done items keep their original index', async ($, on) => {
  await start($, on)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'hit-a-0' })
  await desk.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-a-0' })
  await desk.press({ key: 'done-a' })
  // Item 1 is still hit-a-1 with item 0 folded away; ticking it ticks item 1
  await desk.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'hit-a-1' })
  await desk.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-a-1' })
  expect(await desk.find({ type: 'Text', text: /2\/2 done/ })).toBeTruthy()
  expect((await desk.find({ type: 'Button', key: 'done-a' }))?.props.label).toBe('▸ 2 done')
  await desk.unmount()
})

test('a release that did not start on the row does not tick it', async ($, on) => {
  await start($, on)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-a-0' })
  expect(await desk.find({ type: 'Text', text: /0\/2 done/ })).toBeTruthy()
  await desk.unmount()
})
