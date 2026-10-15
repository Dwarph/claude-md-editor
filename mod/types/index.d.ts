/** One open document, as the daemon's `GET /api/docs` summarises it. */
export type DocSummary = {
  id: string
  path: string
  name: string
  url: string
  suggestions: number
  openComments: number
  draftComments: number
  unseenReviews: number
  editors: number
}

/**
 * The unseen reviews already announced for one document, and how: `append`
 * went into a running turn and is followed up with a prompt if the session
 * goes idle before the agent reads the review.
 */
export type Notified = { count: number; via: 'prompt' | 'append' }

declare module 'claude-code' {
  interface PluginState {
    'md-editor-mod': {
      /** Documents from the last poll; empty while the daemon is down. */
      docs: DocSummary[]
      /** Whether the last poll reached the daemon. */
      isDaemonUp: boolean
      /** Normalised paths of the documents this session works on. */
      owned: string[]
      /** Per document id: the unseen reviews already announced. */
      notified: Record<string, Notified>
      /** Whether the pane was opened unasked once already this session. */
      isPaneOffered: boolean
    }
  }
}
