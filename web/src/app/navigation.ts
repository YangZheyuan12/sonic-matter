import type { Page } from './types'

export type NavigationItem = {
  page: Page
  label: string
}

/** Current product navigation, centralized so the game-audio workflow can replace it in one place. */
export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  { page: 'explore', label: '灵感空间' },
  { page: 'concept', label: '万物声谱' },
  { page: 'studio', label: '音乐工作室' },
  { page: 'sound', label: '音效实验室' },
  { page: 'settings', label: '设置' },
]
