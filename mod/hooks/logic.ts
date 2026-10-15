// Pure helpers: path matching, what to announce, and the status line.
// Everything about documents themselves stays in the daemon.
import type { DocSummary, Notified } from '../types'

const isAbsolute = (path: string) => /^([a-zA-Z]:[\\/]|[\\/])/.test(path)

/** `path` made absolute against `cwd`, in `cwd`'s own separator style. */
export function resolvePath(cwd: string, path: string): string {
  if (isAbsolute(path)) return path
  const sep = cwd.includes('\\') ? '\\' : '/'
  return cwd.replace(/[\\/]+$/, '') + sep + path.replace(/[\\/]/g, sep)
}

/**
 * A comparison key for a path: forward slashes, `.` and `..` folded, lower
 * case (the daemon folds case on Windows; elsewhere a case-only twin is rare).
 */
export function pathKey(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 1) out.pop()
    else out.push(part)
  }
  return out.join('/').toLowerCase()
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function isOwned(doc: DocSummary, owned: readonly string[]): boolean {
  return owned.includes(pathKey(doc.path))
}

/** "draft.md: 3 suggestions, 2 comments" for each of this session's docs with something pending. */
export function statusText(docs: readonly DocSummary[], owned: readonly string[]): string | undefined {
  const parts = docs
    .filter((doc) => isOwned(doc, owned) && (doc.suggestions > 0 || doc.openComments > 0))
    .map((doc) => `${doc.name}: ${plural(doc.suggestions, 'suggestion')}, ${plural(doc.openComments, 'comment')}`)
  return parts.length ? parts.join(' · ') : undefined
}

export type Notice = { doc: DocSummary; via: Notified['via'] }

/**
 * Which of this session's documents to announce a review on, and the record
 * after announcing them. A review is announced once: by prompt when the
 * session is idle, or appended into the running turn, in which case it gets
 * one prompt later only if the session went idle with the review still unread.
 */
export function planNotices(
  docs: readonly DocSummary[],
  owned: readonly string[],
  notified: Readonly<Record<string, Notified>>,
  isTurnRunning: boolean,
): { notices: Notice[]; notified: Record<string, Notified> } {
  const next: Record<string, Notified> = {}
  const notices: Notice[] = []
  for (const doc of docs) {
    if (!isOwned(doc, owned) || doc.unseenReviews === 0) continue
    const prev = notified[doc.id]
    if (!prev || doc.unseenReviews > prev.count) {
      const via = isTurnRunning ? 'append' : 'prompt'
      notices.push({ doc, via })
      next[doc.id] = { count: doc.unseenReviews, via }
    } else if (prev.via === 'append' && !isTurnRunning) {
      notices.push({ doc, via: 'prompt' })
      next[doc.id] = { count: doc.unseenReviews, via: 'prompt' }
    } else {
      next[doc.id] = { count: doc.unseenReviews, via: prev.via }
    }
  }
  return { notices, notified: next }
}

export function noticeText(doc: DocSummary, comments: number, replies = 0): string {
  const what = [comments || !replies ? plural(comments, 'comment') : null, replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : null]
  const title = comments || !replies ? 'Review submitted' : 'New reply'
  return `${title} on ${doc.name}: ${what.filter(Boolean).join(', ')}. Use the collab-md skill: call get_review for ${doc.path}.`
}
