import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DashboardRoot } from './DashboardRoot.js'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <DashboardRoot />
    </StrictMode>
  )
}
