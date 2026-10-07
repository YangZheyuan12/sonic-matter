import type { Page } from './types'

export type NavigationItem = {
  page: Page
  label: string
}

/** Product-level navigation; legacy feature views live inside these workspaces. */
export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  { page: 'brief', label: 'Game Brief' },
  { page: 'direction', label: 'Sound Direction' },
  { page: 'studio', label: 'Music Studio' },
  { page: 'sfx', label: 'SFX Lab' },
  { page: 'my', label: 'My' },
]
