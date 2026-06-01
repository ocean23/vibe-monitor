import React from 'react'
import ReactDOM from 'react-dom/client'
import { IslandRoot } from './pages/Island'
import './styles/design-tokens.css'
import './styles/app.css'

// vibe-monitor 渲染端只有灵动岛一块：透明置顶刘海窗口，直接挂载 IslandRoot。
document.body.classList.add('island-body')

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <IslandRoot />
  </React.StrictMode>
)
