import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // 固定 127.0.0.1 + 5173：Vite 8 默认只监听 ::1，浏览器访问 http://127.0.0.1:5173 会连不上；
    // strictPort 让端口被占用时直接报错，而不是悄悄换到 5174。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8787',
      '/generated': 'http://localhost:8787',
    },
  },
})
