import { expect, test } from 'claude-code/testing'
import { makePin } from '../hooks/pins.js'

const PANE = {
  plugin: 'sticky-notes',
  component: 'Pane',
  requestId: 'sticky',
  props: { title: 'Sticky notes', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const checklist = makePin({ id: 'a', source: 'claude', text: '## Setup\n1. Run `npm install` then `npm test`\n2. A very long second step that must wrap instead of being clipped at the pane edge\n   ```bash\n   git push\n   ```' })
const message = makePin({ id: 'b', source: 'message', text: 'Intro\n\n| Name | Cmd |\n| --- | --- |\n| one | `ls -la` |\n\n```sh\nls\n```' })

test('the sidebar draws copy buttons, snippets and tables on desktop and terminal', async ($, on) => {
  on('store.get', () => ({ value: { pins: [checklist, message] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.register', () => ({ value: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'copy-a' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'chip-a-0-chip-copy-0' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'seg-b-1-c1-1' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /one/ })).toBeTruthy()
    await ui.unmount()
  }
})
