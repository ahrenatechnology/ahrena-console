// Captura cada tela de docs/wireframes/index.html?captura=<id> em PNG, via CDP no chrome-headless-shell.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const [,, chrome, base, saida, ...ids] = process.argv
const proc = spawn(chrome, ['--headless', '--remote-debugging-port=9333', '--hide-scrollbars', '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let alvo
for (let i = 0; i < 50 && !alvo; i++) { await sleep(200); try { alvo = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(t => t.type === 'page') } catch {} }
const ws = new WebSocket(alvo.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
let seq = 0; const esperando = new Map()
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && esperando.has(m.id)) { esperando.get(m.id)(m); esperando.delete(m.id) } })
const cdp = (method, params = {}) => new Promise(r => { const id = ++seq; esperando.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
await cdp('Page.enable'); await cdp('Runtime.enable')
await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 2, mobile: false })
for (const id of ids) {
  await cdp('Page.navigate', { url: `${base}?captura=${id}` })
  await sleep(1800)
  const r = await cdp('Runtime.evaluate', { expression: `document.fonts.ready.then(()=>{const m=document.querySelector('main').getBoundingClientRect();return JSON.stringify({x:m.x,y:m.y,w:m.width,h:m.height,e:window.estouros.length})})`, awaitPromise: true, returnByValue: true })
  const b = JSON.parse(r.result.result.value)
  if (b.h > 1200) await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: Math.ceil(b.h) + 10, deviceScaleFactor: 2, mobile: false })
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 }, captureBeyondViewport: true })
  writeFileSync(`${saida}/${id}.png`, Buffer.from(shot.result.data, 'base64'))
  console.log(id, Math.round(b.w), 'x', Math.round(b.h), 'estouros:', b.e)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 2, mobile: false })
}
ws.close(); proc.kill()
