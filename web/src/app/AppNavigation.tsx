import { NAVIGATION_ITEMS } from './navigation'
import type { Page } from './types'

export type AppNavigationProps = {
  active: Page
  onNavigate: (page: Page) => void
}

export default function AppNavigation({ active, onNavigate }: AppNavigationProps) {
  return <nav className="nav">
    {NAVIGATION_ITEMS.map(item => (
      <button
        className={active === item.page ? 'active' : ''}
        key={item.page}
        onClick={() => onNavigate(item.page)}
      >
        {item.label}
      </button>
    ))}
  </nav>
}
