// Minimal line diff (LCS) so the agent can see what the person changed since
// it last read the document. Documents here are prose-sized, so O(n*m) is fine.

/** Returns a unified-style diff ("- old", "+ new", "  same") or '' when equal. */
export function lineDiff(before, after, context = 2) {
  if (before === after) return ''
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push(['  ', a[i]]); i++; j++
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      ops.push(['+ ', b[j]]); j++
    } else {
      ops.push(['- ', a[i]]); i++
    }
  }
  // Keep only changed lines plus a little context around them.
  const keep = new Array(ops.length).fill(false)
  ops.forEach(([tag], k) => {
    if (tag === '  ') return
    for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) keep[c] = true
  })
  const out = []
  let skipped = false
  ops.forEach(([tag, line], k) => {
    if (keep[k]) {
      out.push(tag + line)
      skipped = false
    } else if (!skipped) {
      out.push('  ...')
      skipped = true
    }
  })
  return out.join('\n')
}
