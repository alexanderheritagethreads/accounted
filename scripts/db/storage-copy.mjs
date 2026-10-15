#!/usr/bin/env node
// Copy every Supabase Storage object from one Supabase API to another
// (Supabase Cloud → self-hosted on Railway). Read-only on the source.
//
//   SRC_URL=… SRC_KEY=<source service_role> DST_URL=… DST_KEY=<target service_role> \
//     node scripts/db/storage-copy.mjs <objects.tsv>
//
// objects.tsv: "bucket_id<TAB>name<TAB>size" per line (from storage.objects).
// The target's storage.objects rows already exist (restored with the DB), but
// its bucket holds no files yet, so each object is uploaded with x-upsert.
// Verifies size + sha256 of what the target serves back.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const { SRC_URL, SRC_KEY, DST_URL, DST_KEY } = process.env
if (!SRC_URL || !SRC_KEY || !DST_URL || !DST_KEY) {
  console.error('SRC_URL, SRC_KEY, DST_URL and DST_KEY are required')
  process.exit(2)
}
const auth = (key) => ({ apikey: key, Authorization: `Bearer ${key}` })
const path = (name) => name.split('/').map(encodeURIComponent).join('/')
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

const rows = readFileSync(process.argv[2], 'utf8')
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => { const [bucket, name, size] = l.split('\t'); return { bucket, name, size: Number(size) } })

let ok = 0
const failed = []
for (const { bucket, name, size } of rows) {
  try {
    const src = await fetch(`${SRC_URL}/storage/v1/object/${bucket}/${path(name)}`, { headers: auth(SRC_KEY) })
    if (!src.ok) throw new Error(`source ${src.status}`)
    const type = src.headers.get('content-type') || 'application/octet-stream'
    const body = Buffer.from(await src.arrayBuffer())
    if (Number.isFinite(size) && size > 0 && body.length !== size) throw new Error(`source size ${body.length} != ${size}`)

    const up = await fetch(`${DST_URL}/storage/v1/object/${bucket}/${path(name)}`, {
      method: 'POST',
      headers: { ...auth(DST_KEY), 'content-type': type, 'x-upsert': 'true', 'cache-control': '3600' },
      body,
    })
    if (!up.ok) throw new Error(`upload ${up.status} ${(await up.text()).slice(0, 120)}`)

    const back = await fetch(`${DST_URL}/storage/v1/object/${bucket}/${path(name)}`, { headers: auth(DST_KEY) })
    const got = Buffer.from(await back.arrayBuffer())
    if (!back.ok || sha(got) !== sha(body)) throw new Error(`verify ${back.status} size ${got.length}`)
    ok++
  } catch (err) {
    failed.push(`${bucket}/${name}: ${err.message}`)
  }
}
console.log(`kopierade och verifierade: ${ok}/${rows.length}`)
for (const f of failed) console.log(`FEL ${f}`)
process.exit(failed.length ? 1 : 0)
