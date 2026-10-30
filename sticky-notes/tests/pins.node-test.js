// Plain Node tests for the pure logic in hooks/pins.js.
// Run with: node --test sticky-notes/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makePin, toggleItem, progress, hashText, stripInline, parsePinArgs, parseUnpinArgs } from '../hooks/pins.js'

test('a numbered list becomes a checklist titled by its heading', () => {
  const pin = makePin({
    id: 'a',
    source: 'message',
    text: '## Set up the database\n\n1. Install Postgres\n2. Create the `app` user\n3. Run **migrations**',
  })
  assert.equal(pin.title, 'Set up the database')
  assert.deepEqual(
    pin.items.map((i) => i.text),
    ['Install Postgres', 'Create the app user', 'Run migrations'],
  )
  assert.ok(pin.items.every((i) => i.done === false))
})

test('without a heading, the first plain line is the title', () => {
  const pin = makePin({ id: 'a', source: 'message', text: 'Here is what to do:\n\n- one\n- two' })
  assert.equal(pin.title, 'Here is what to do:')
  assert.equal(pin.items.length, 2)
})

test('an explicit title wins', () => {
  const pin = makePin({ id: 'a', source: 'message', title: 'Deploy', text: '# Other\n- a\n- b' })
  assert.equal(pin.title, 'Deploy')
})

test('markdown task boxes keep their done state', () => {
  const pin = makePin({ id: 'a', source: 'message', text: '- [x] done thing\n- [ ] open thing' })
  assert.deepEqual(
    pin.items.map((i) => [i.text, i.done]),
    [['done thing', true], ['open thing', false]],
  )
})

test('code blocks and indented lines attach to the item above as detail', () => {
  const text = [
    'Steps:',
    '1. Install deps',
    '```bash',
    'npm install',
    '- not an item',
    '```',
    '2. Start it',
    '   it listens on port 3000',
  ].join('\n')
  const pin = makePin({ id: 'a', source: 'message', text })
  assert.equal(pin.items.length, 2)
  assert.equal(pin.items[0].detail, 'npm install\n- not an item')
  assert.equal(pin.items[1].detail, 'it listens on port 3000')
})

test('nested bullets are items with a depth', () => {
  const pin = makePin({ id: 'a', source: 'message', text: '1. Parent\n   - child a\n   - child b\n2. Next' })
  assert.deepEqual(
    pin.items.map((i) => [i.text, i.depth]),
    [['Parent', 0], ['child a', 1], ['child b', 1], ['Next', 0]],
  )
})

test('a single bullet is not a checklist', () => {
  const pin = makePin({ id: 'a', source: 'message', text: 'Remember:\n- one thing only' })
  assert.equal(pin.items, null)
  assert.equal(pin.body, 'Remember:\n- one thing only')
})

test('a note keeps its text as body and is titled by its first line', () => {
  const pin = makePin({ id: 'a', source: 'note', text: 'ask about the staging URL' })
  assert.equal(pin.items, null)
  assert.equal(pin.title, 'ask about the staging URL')
})

test('long titles are shortened', () => {
  const pin = makePin({ id: 'a', source: 'note', text: 'x'.repeat(200) })
  assert.ok(pin.title.length <= 60)
  assert.ok(pin.title.endsWith('…'))
})

test('toggleItem flips one item and leaves the input alone', () => {
  const pins = [makePin({ id: 'a', source: 'message', text: '- a\n- b' })]
  const next = toggleItem(pins, 'a', 1)
  assert.equal(next[0].items[1].done, true)
  assert.equal(pins[0].items[1].done, false)
  assert.deepEqual(progress(next[0]), { done: 1, total: 2 })
})

test('hashText is stable and whitespace-insensitive at the ends', () => {
  assert.equal(hashText('hello'), hashText('  hello\n'))
  assert.notEqual(hashText('hello'), hashText('hellp'))
})

test('stripInline removes markdown emphasis, code ticks and links', () => {
  assert.equal(stripInline('Run **`npm test`** and see [docs](http://x)'), 'Run npm test and see docs')
})

test('a one-line note has no body that repeats its title', () => {
  const pin = makePin({ id: 'a', source: 'note', text: 'buy milk' })
  assert.equal(pin.title, 'buy milk')
  assert.equal(pin.body, null)
})

test('parsePinArgs reads an index only when it is a whole word', () => {
  assert.deepEqual(parsePinArgs(''), { n: 1, title: '' })
  assert.deepEqual(parsePinArgs('2'), { n: 2, title: '' })
  assert.deepEqual(parsePinArgs('2 Deploy steps'), { n: 2, title: 'Deploy steps' })
  assert.deepEqual(parsePinArgs('3rd step'), { n: 1, title: '3rd step' })
  assert.deepEqual(parsePinArgs('Deploy steps'), { n: 1, title: 'Deploy steps' })
})

test('parseUnpinArgs refuses anything that is not a positive index or all', () => {
  assert.deepEqual(parseUnpinArgs(''), { n: 1 })
  assert.deepEqual(parseUnpinArgs('3'), { n: 3 })
  assert.deepEqual(parseUnpinArgs('all'), { all: true })
  for (const bad of ['al', 'foo', '0', '-2', '2x']) assert.ok(parseUnpinArgs(bad).error, bad)
})
