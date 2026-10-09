import 'dotenv/config'
import path from 'node:path'
import { GenerationStore } from './generationStore.ts'

// 仅服务器本地运维使用，输出汇总次数，不读取密码、提示词或供应商密钥。
const store = new GenerationStore(path.resolve(process.env.AUTH_DIR ?? 'auth'))
try { console.log(JSON.stringify(store.summary(), null, 2)) } finally { store.close() }
