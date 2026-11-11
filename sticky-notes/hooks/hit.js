// A click layer laid over a desktop checklist row, after filetree's hit.tsx.
// A desktop Button flattens the Text inside it, losing the strikethrough on a
// ticked item, and truncates long items, so the row draws its own Text and
// this catches the click. Once clicked it holds the focus, and Enter or Space
// tick it too.
export default function Hit(props, surface) {
  const { Box } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { ref: {} }
    surface.setState(state)
  }
  const ref = state.ref
  ref.unpoint ??= surface.onPointer((e) => {
    const left = (e.button ?? 'left') === 'left'
    // Only a press that went down on this row ticks it, not a drag ending here
    if (e.type === 'down' && left) ref.isDown = true
    else if (e.type === 'leave') ref.isDown = false
    else if (e.type === 'up' && left && ref.isDown) {
      ref.isDown = false
      surface.post({ press: true })
    }
  })
  ref.unkey ??= surface.onKey((e) => {
    if (e.key === 'return' || e.key === 'enter' || e.key === ' ' || e.key === 'space') surface.post({ press: true })
  })
  return Box({ width: '100%', height: '100%' })
}
