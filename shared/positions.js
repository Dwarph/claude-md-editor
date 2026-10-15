// Anchors for suggestions and comments: ProseMirror positions stored as Yjs
// relative positions, so they follow the text as either side edits around them.
import * as Y from 'yjs'
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from 'y-prosemirror'

function toBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** ProseMirror position -> encoded Yjs relative position. */
export function encodeAnchor(pos, fragment, mapping) {
  const rel = absolutePositionToRelativePosition(pos, fragment, mapping)
  return toBase64(Y.encodeRelativePosition(rel))
}

/** Encoded relative position -> current ProseMirror position, or null if its text is gone. */
export function decodeAnchor(anchor, ydoc, fragment, mapping) {
  if (!anchor) return null
  try {
    const rel = Y.decodeRelativePosition(fromBase64(anchor))
    return relativePositionToAbsolutePosition(ydoc, fragment, rel, mapping)
  } catch {
    // The mapping hasn't caught up with a just-arrived update; callers retry on the next refresh.
    return null
  }
}

/** Resolve a {from, to} anchor pair to a valid, ordered ProseMirror range. */
export function resolveRange(item, ydoc, fragment, mapping) {
  const from = decodeAnchor(item.from, ydoc, fragment, mapping)
  const to = decodeAnchor(item.to, ydoc, fragment, mapping)
  if (from === null || to === null) return null
  return from <= to ? { from, to } : { from: to, to: from }
}
