import { spawn } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.join(repositoryRoot, 'docs', 'agent', 'demo-video.webm')
const durationMs = 125_000

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

async function findChrome() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next platform-specific location.
    }
  }
  throw new Error('未找到 Chrome。可通过 CHROME_PATH 指定浏览器路径。')
}

function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>Audio Director Agent Demo</title>
<style>html,body{margin:0;background:#070b16;color:#eef2ff;font-family:Arial,"Microsoft YaHei",sans-serif;display:grid;place-items:center;height:100%}canvas{width:960px;height:540px;box-shadow:0 24px 80px #0008}</style>
<canvas id="demo" width="960" height="540"></canvas>
<script>
const canvas=document.querySelector('#demo');const c=canvas.getContext('2d');
const DURATION=${durationMs};const started=performance.now();
const scenes=[
  {from:0,to:15000,kicker:'SONIC / MATTER',title:'Audio Director Agent',body:['自然语言意图 → 可编辑音乐工程','可规划 · 可验证 · 可修订 · 可审计'],accent:'#7dd3fc'},
  {from:15000,to:39000,kicker:'01 受约束执行',title:'模型负责选择，程序负责边界',body:['安全检查  →  Planner  →  白名单工具','候选快照  →  Evaluator  →  人工批准','原工程在批准前始终保持不变'],accent:'#a78bfa'},
  {from:39000,to:63000,kicker:'02 直接成功',title:'添加一条低沉大提琴轨道',body:['✓ add_track：1 次工具调用','✓ 结构、约束与可导出性通过','● awaiting_approval：等待用户查看差异'],accent:'#34d399'},
  {from:63000,to:89000,kicker:'03 自动修订',title:'第一次没有完成 Cello 替换',body:['inspect_project  →  验收失败','Evaluator：缺少 instrument = Cello','Revision：update_track  →  重新验收通过','2 次调用 · 1 次修订 · 65 ms 逻辑耗时'],accent:'#fbbf24'},
  {from:89000,to:108000,kicker:'04 安全失败',title:'拒绝绕过审批与系统工具注入',body:['✓ 0 次工具调用','✓ unsafe_instruction','✓ 源快照不变，未发现敏感输出'],accent:'#fb7185'},
  {from:108000,to:DURATION,kicker:'05 可重复证据',title:'20 / 20 固定离线案例通过',body:['约束满足率 100% · 一次完成率 93.33%','修订成功率 100% · 真实付费调用 0','复现：npm run eval:agent  &&  npm run verify'],accent:'#60a5fa'}
];
function rounded(x,y,w,h,r){c.beginPath();c.roundRect(x,y,w,h,r);c.fill()}
function text(value,x,y,size,color='#eef2ff',weight=500){c.fillStyle=color;c.font=weight+' '+size+'px Arial,"Microsoft YaHei",sans-serif';c.fillText(value,x,y)}
function draw(now){
 const elapsed=Math.min(DURATION,now-started);const scene=scenes.find(s=>elapsed>=s.from&&elapsed<s.to)||scenes.at(-1);
 const local=(elapsed-scene.from)/(scene.to-scene.from);const fade=Math.min(1,local*5,(1-local)*5+0.05);
 const g=c.createLinearGradient(0,0,960,540);g.addColorStop(0,'#07111f');g.addColorStop(1,'#140d25');c.fillStyle=g;c.fillRect(0,0,960,540);
 c.globalAlpha=.18;for(let i=0;i<28;i++){const x=(i*173+elapsed*.006)%1000-20;const y=(i*97)%560-10;c.fillStyle=i%3?'#7dd3fc':'#a78bfa';c.beginPath();c.arc(x,y,1+(i%3),0,Math.PI*2);c.fill()}
 c.globalAlpha=fade;c.fillStyle='#0f172acc';rounded(54,54,852,404,28);c.strokeStyle=scene.accent+'66';c.lineWidth=2;c.strokeRect(55,55,850,402);
 c.fillStyle=scene.accent;rounded(86,91,96,5,3);text(scene.kicker,86,132,17,scene.accent,700);text(scene.title,86,194,34,'#f8fafc',700);
 scene.body.forEach((line,index)=>{c.fillStyle=index===scene.body.length-1?scene.accent:'#cbd5e1';rounded(86,235+index*49,10,10,5);text(line,112,248+index*49,21,index===scene.body.length-1?scene.accent:'#cbd5e1',500)});
 const progress=elapsed/DURATION;c.fillStyle='#1e293b';rounded(86,421,788,7,4);c.fillStyle=scene.accent;rounded(86,421,Math.max(8,788*progress),7,4);text(Math.floor(elapsed/60000)+':'+String(Math.floor(elapsed/1000)%60).padStart(2,'0')+' / 2:05',786,448,14,'#94a3b8',500);
 c.globalAlpha=1;if(elapsed<DURATION)requestAnimationFrame(draw)
}
requestAnimationFrame(draw);
const stream=canvas.captureStream(8);const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';
const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:260000});const chunks=[];
recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
recorder.onstop=async()=>{const blob=new Blob(chunks,{type:mime});const response=await fetch('/upload',{method:'POST',headers:{'content-type':'video/webm'},body:blob});document.title=response.ok?'录制完成':'录制失败'};
recorder.start(1000);setTimeout(()=>recorder.stop(),DURATION);
</script></html>`
}

const temporaryProfile = await mkdtemp(path.join(tmpdir(), 'sonic-agent-demo-'))
let resolveUpload
let rejectUpload
const uploaded = new Promise((resolve, reject) => {
  resolveUpload = resolve
  rejectUpload = reject
})

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(pageHtml())
    return
  }
  if (request.method === 'POST' && request.url === '/upload') {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('error', rejectUpload)
    request.on('end', async () => {
      try {
        const video = Buffer.concat(chunks)
        if (video.length < 10_000 || !video.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
          throw new Error('Chrome 返回的内容不是有效的 WebM 视频。')
        }
        await writeFile(outputPath, video)
        response.writeHead(204).end()
        resolveUpload(video.length)
      } catch (error) {
        response.writeHead(500).end()
        rejectUpload(error)
      }
    })
    return
  }
  response.writeHead(404).end()
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (typeof address === 'string' || address === null) throw new Error('无法启动演示录制服务。')

const chrome = await findChrome()
const browser = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  `--user-data-dir=${temporaryProfile}`,
  `http://127.0.0.1:${address.port}/`,
], { stdio: 'ignore' })

let timeoutId
try {
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('演示视频录制超时。')), durationMs + 30_000)
  })
  const size = await Promise.race([uploaded, timeout])
  console.log(`演示视频已生成：${path.relative(repositoryRoot, outputPath)}（${size} bytes，2:05）`)
} finally {
  clearTimeout(timeoutId)
  browser.kill()
  await new Promise(resolve => server.close(resolve))
  const resolvedTemp = path.resolve(temporaryProfile)
  if (path.dirname(resolvedTemp) === path.resolve(tmpdir()) && path.basename(resolvedTemp).startsWith('sonic-agent-demo-')) {
    await rm(resolvedTemp, { recursive: true, force: true }).catch(() => undefined)
  }
}
