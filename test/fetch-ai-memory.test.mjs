// #719/AC-1 (#725): fetch-and-verify of the pinned ai-memory, with the download injected (no network).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AI_MEMORY_VERSION, run, tarballUrl } from '../scripts/fetch-ai-memory.mjs'

const BINARY = '#!/bin/sh\necho fake-binary\n'
const LICENSE = 'fake licence text\n'

function fakeTarball(dir) {
  const root = join(dir, 'root')
  for (const sub of ['docs', 'hooks', 'packaging/launchd']) mkdirSync(join(root, sub), { recursive: true })
  writeFileSync(join(root, 'ai-memory'), BINARY, { mode: 0o755 })
  writeFileSync(join(root, 'LICENSE'), LICENSE)
  writeFileSync(join(root, 'docs', 'guide.md'), 'docs\n')
  writeFileSync(join(root, 'hooks', 'hook.sh'), 'hook\n')
  writeFileSync(join(root, 'packaging', 'launchd', 'x.plist'), 'plist\n')
  const file = join(dir, 'fake.tar.gz')
  execFileSync('tar', ['-czf', file, '-C', root, './ai-memory', './LICENSE', './docs', './hooks', './packaging'])
  return readFileSync(file)
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function release(tarball, shaFile, arch = 'aarch64') {
  const asked = []
  const url = tarballUrl(arch)
  const download = async (u) => {
    asked.push(u)
    if (u === url) return tarball
    if (u === `${url}.sha256`) return Buffer.from(shaFile)
    throw new Error(`unexpected url ${u}`)
  }
  return { download, asked }
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'fetch-ai-memory-'))
  return { dir, out: join(dir, 'build', 'ai-memory'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

const quiet = { log: () => {}, error: () => {} }

test('#719/AC-1 the pinned release is v3.5.1 and the URLs name the arch', () => {
  assert.equal(AI_MEMORY_VERSION, 'v3.5.1')
  assert.equal(tarballUrl('aarch64'), 'https://github.com/akitaonrails/ai-memory/releases/download/v3.5.1/ai-memory-macos-aarch64.tar.gz')
  assert.equal(tarballUrl('x86_64'), 'https://github.com/akitaonrails/ai-memory/releases/download/v3.5.1/ai-memory-macos-x86_64.tar.gz')
})

for (const arch of ['aarch64', 'x86_64']) {
  test(`#719/AC-1 #725/AC-1 a matching hash copies the binary (executable) and the LICENSE, and nothing else (${arch})`, async () => {
    const s = scratch()
    try {
      const tarball = fakeTarball(s.dir)
      const { download, asked } = release(tarball, `${sha256(tarball)}  ai-memory-macos-${arch}.tar.gz\n`, arch)
      const code = await run(['--arch', arch, '--out', s.out], { download, ...quiet })
      assert.equal(code, 0)
      assert.deepEqual(asked, [tarballUrl(arch), `${tarballUrl(arch)}.sha256`])
      assert.deepEqual(readdirSync(s.out).sort(), ['LICENSE', 'ai-memory'])
      assert.equal(readFileSync(join(s.out, 'ai-memory'), 'utf8'), BINARY)
      assert.equal(readFileSync(join(s.out, 'LICENSE'), 'utf8'), LICENSE)
      assert.ok(statSync(join(s.out, 'ai-memory')).mode & 0o100, 'the binary stays executable')
    } finally {
      s.done()
    }
  })
}

test('#719/AC-1 a hash that differs exits non-zero and copies nothing', async () => {
  const s = scratch()
  try {
    const tarball = fakeTarball(s.dir)
    const { download } = release(tarball, `${'0'.repeat(64)}  ai-memory-macos-aarch64.tar.gz\n`)
    const code = await run(['--arch', 'aarch64', '--out', s.out], { download, ...quiet })
    assert.notEqual(code, 0)
    assert.equal(existsSync(s.out), false)
  } finally {
    s.done()
  }
})

test('#719/AC-1 a malformed .sha256 file exits non-zero and copies nothing', async () => {
  const s = scratch()
  try {
    const tarball = fakeTarball(s.dir)
    for (const bad of ['', 'not a hash\n', `${sha256(tarball).slice(0, 63)}  file\n`]) {
      const { download } = release(tarball, bad)
      assert.notEqual(await run(['--arch', 'aarch64', '--out', s.out], { download, ...quiet }), 0, JSON.stringify(bad))
      assert.equal(existsSync(s.out), false)
    }
  } finally {
    s.done()
  }
})

test('#719/AC-1 the hash is read from the first 64-hex token, in either case', async () => {
  const s = scratch()
  try {
    const tarball = fakeTarball(s.dir)
    const { download } = release(tarball, `${sha256(tarball).toUpperCase()}\n`)
    assert.equal(await run(['--arch', 'aarch64', '--out', s.out], { download, ...quiet }), 0)
  } finally {
    s.done()
  }
})

test('#719/AC-1 a tarball without the LICENSE exits non-zero and copies nothing', async () => {
  const s = scratch()
  try {
    const root = join(s.dir, 'bare')
    mkdirSync(root)
    writeFileSync(join(root, 'ai-memory'), BINARY)
    const file = join(s.dir, 'bare.tar.gz')
    execFileSync('tar', ['-czf', file, '-C', root, './ai-memory'])
    const tarball = readFileSync(file)
    const { download } = release(tarball, `${sha256(tarball)}  x\n`)
    assert.notEqual(await run(['--arch', 'aarch64', '--out', s.out], { download, ...quiet }), 0)
    assert.equal(existsSync(s.out), false)
  } finally {
    s.done()
  }
})

test('#719/AC-1 a download failure exits non-zero and copies nothing', async () => {
  const s = scratch()
  try {
    const download = async () => {
      throw new Error('offline')
    }
    assert.notEqual(await run(['--arch', 'aarch64', '--out', s.out], { download, ...quiet }), 0)
    assert.equal(existsSync(s.out), false)
  } finally {
    s.done()
  }
})

test('#719/AC-1 a success replaces what an earlier run left in the build folder', async () => {
  const s = scratch()
  try {
    mkdirSync(s.out, { recursive: true })
    writeFileSync(join(s.out, 'stale'), 'old')
    const tarball = fakeTarball(s.dir)
    const { download } = release(tarball, `${sha256(tarball)}\n`)
    assert.equal(await run(['--arch', 'aarch64', '--out', s.out], { download, ...quiet }), 0)
    assert.deepEqual(readdirSync(s.out).sort(), ['LICENSE', 'ai-memory'])
  } finally {
    s.done()
  }
})

test('#719/AC-1 an unknown arch exits non-zero before any download', async () => {
  let called = false
  const download = async () => {
    called = true
    return Buffer.alloc(0)
  }
  assert.notEqual(await run(['--arch', 'riscv'], { download, ...quiet }), 0)
  assert.equal(called, false)
})
