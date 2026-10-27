'use strict'

const test = require('node:test')
const FormData = require('form-data')
const Fastify = require('fastify')
const multipart = require('..')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')
const { Writable } = require('node:stream')
const { once } = require('node:events')

// Builds a server whose error-level "Could not delete file" log lines are collected.
function buildFastify (t) {
  const deleteErrors = []
  const stream = new Writable({
    write (chunk, encoding, callback) {
      const line = JSON.parse(chunk.toString())
      if (line.msg === 'Could not delete file') {
        deleteErrors.push(line)
      }
      callback()
    }
  })
  const fastify = Fastify({ logger: { level: 'error', stream } })
  t.after(() => fastify.close())
  return { fastify, deleteErrors }
}

// Resolves after the plugin's own onResponse cleanup, which was registered first.
function cleanupDone (fastify) {
  return new Promise((resolve) => {
    fastify.addHook('onResponse', async () => { resolve() })
  })
}

async function upload (fastify, size) {
  const form = new FormData()
  form.append('upload', Buffer.alloc(size), { filename: 'upload.bin' })
  const req = http.request({
    protocol: 'http:',
    hostname: 'localhost',
    port: fastify.server.address().port,
    path: '/',
    headers: form.getHeaders(),
    method: 'POST'
  })
  req.end(form.getBuffer())
  const [res] = await once(req, 'response')
  res.resume()
  await once(res, 'end')
  return res.statusCode
}

test('should not log a delete error for temp files already removed after the fileSize limit is hit', async function (t) {
  t.plan(3)

  const { fastify, deleteErrors } = buildFastify(t)
  await fastify.register(multipart)

  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'multipart-'))
  t.after(() => fs.rm(tmpdir, { recursive: true, force: true }))

  // saveRequestFiles() removes the saved file when it rejects, then onResponse
  // runs the cleanup again for the same path
  fastify.post('/', async function (req) {
    await req.saveRequestFiles({ tmpdir, limits: { fileSize: 100 } })
  })
  const cleanedUp = cleanupDone(fastify)

  await fastify.listen({ port: 0 })

  t.assert.strictEqual(await upload(fastify, 1024), 413)
  await cleanedUp
  t.assert.deepStrictEqual(await fs.readdir(tmpdir), [], 'temp file was removed')
  t.assert.deepStrictEqual(deleteErrors, [], 'no delete error was logged')
})

test('should not log a delete error when the handler moved the saved file', async function (t) {
  t.plan(4)

  const { fastify, deleteErrors } = buildFastify(t)
  await fastify.register(multipart)

  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'multipart-'))
  const destdir = await fs.mkdtemp(path.join(os.tmpdir(), 'multipart-dest-'))
  t.after(() => fs.rm(tmpdir, { recursive: true, force: true }))
  t.after(() => fs.rm(destdir, { recursive: true, force: true }))

  fastify.post('/', async function (req) {
    const { files } = await req.saveRequestFiles({ tmpdir })
    await fs.rename(files[0].filepath, path.join(destdir, 'kept.bin'))
    return { ok: true }
  })
  const cleanedUp = cleanupDone(fastify)

  await fastify.listen({ port: 0 })

  t.assert.strictEqual(await upload(fastify, 1024), 200)
  await cleanedUp
  t.assert.deepStrictEqual(await fs.readdir(destdir), ['kept.bin'], 'moved file was kept')
  t.assert.deepStrictEqual(await fs.readdir(tmpdir), [])
  t.assert.deepStrictEqual(deleteErrors, [], 'no delete error was logged')
})

test('should still log a delete error when a temp file cannot be removed', async function (t) {
  t.plan(3)

  const { fastify, deleteErrors } = buildFastify(t)
  await fastify.register(multipart)

  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'multipart-'))
  t.after(() => fs.rm(tmpdir, { recursive: true, force: true }))

  fastify.post('/', async function (req) {
    const { files } = await req.saveRequestFiles({ tmpdir })
    // replace the saved file with a directory, which unlink() cannot remove
    await fs.unlink(files[0].filepath)
    await fs.mkdir(files[0].filepath)
    return { ok: true }
  })
  const cleanedUp = cleanupDone(fastify)

  await fastify.listen({ port: 0 })

  t.assert.strictEqual(await upload(fastify, 1024), 200)
  await cleanedUp
  t.assert.strictEqual(deleteErrors.length, 1, 'the failed delete was logged')
  t.assert.notStrictEqual(deleteErrors[0].err.code, 'ENOENT')
})
