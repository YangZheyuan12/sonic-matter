export type Page = 'explore' | 'concept' | 'studio' | 'sound' | 'settings'

export const primaryNavigation = [
  { page: 'explore', label: '首页' },
  { page: 'concept', label: '定义你的游戏' },
  { page: 'studio', label: '音乐工作室' },
  { page: 'sound', label: '音效实验室' },
] as const satisfies ReadonlyArray<{ page: Exclude<Page, 'settings'>; label: string }>

export const myPage: Page = 'settings'
