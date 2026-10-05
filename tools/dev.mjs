/**
 * 一条命令同时启动后端（8787）与前端（5173），Ctrl+C 时一起退出。
 *
 * 零依赖实现：不引入 concurrently，避免为了一个脚本增加生产依赖。
 * 用法：在仓库根目录执行 `npm run dev`（等价于 `node tools/dev.mjs`）。
 */
import { spawn } from 'node:child_process'

const isWindows = process.platform === 'win32'
const targets = [
  { name: 'server', color: '\u001B[35m', command: 'npm run dev --prefix server' },
  { name: 'web', color: '\u001B[36m', command: 'npm run dev --prefix web' },
]
const RESET = '\u001B[0m'
const DIM = '\u001B[2m'

const children = []
let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    if (isWindows) {
      // Windows 上 npm 会再拉起子进程，必须整棵进程树一起结束，否则端口不会释放。
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  }
  setTimeout(() => process.exit(code), 300)
}

for (const target of targets) {
  // Windows 下 npm 是 .cmd，必须经过 shell 才能真正执行；
  // 这里整条命令作为字符串传入，避免 spawn(shell: true) + 参数数组的转义告警。
  const child = spawn(target.command, { stdio: ['ignore', 'pipe', 'pipe'], shell: true })
  children.push(child)

  const prefix = `${target.color}[${target.name}]${RESET} `
  const pipe = (stream, sink) => {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) sink.write(`${prefix}${line}\n`)
    })
    stream.on('end', () => { if (buffer) sink.write(`${prefix}${buffer}\n`) })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)

  child.on('error', error => {
    process.stderr.write(`${prefix}启动失败：${error.message}\n`)
    shutdown(1)
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    process.stdout.write(`${prefix}${DIM}进程已退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}），正在停止另一个服务…${RESET}\n`)
    shutdown(code ?? 0)
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.stdout.write(`${DIM}正在启动 server(8787) 与 web(5173)，按 Ctrl+C 停止…${RESET}\n`)
