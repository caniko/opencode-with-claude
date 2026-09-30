import assert from "node:assert/strict"
import test from "node:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

// Coverage for MERIDIAN_PATH (#221): the plugin must prefer a user-supplied
// Meridian build, accept the layouts a user is likely to have on hand, and
// fall back to the bundled dependency without failing when the path is wrong.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const BUNDLED_ROOT = join(REPO_ROOT, "node_modules", "@rynfar", "meridian")

function bundledVersion() {
  return JSON.parse(readFileSync(join(BUNDLED_ROOT, "package.json"), "utf8")).version
}

async function freshImport() {
  return await import(`../../src/meridian-source.ts?t=${Date.now()}${Math.random()}`)
}

/** Run `fn` with MERIDIAN_PATH set (or cleared when `value` is undefined). */
async function withMeridianPath(value, fn) {
  const previous = process.env.MERIDIAN_PATH
  if (value === undefined) delete process.env.MERIDIAN_PATH
  else process.env.MERIDIAN_PATH = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.MERIDIAN_PATH
    else process.env.MERIDIAN_PATH = previous
  }
}

function collectLogs() {
  const logs = []
  return {
    logs,
    log: async (level, message) => {
      logs.push({ level, message })
    },
  }
}

/**
 * A stand-in Meridian install. Copying the real package would cost seconds per
 * test; what matters is the manifest shape (name, version, exports) and that
 * the entry exports `startProxyServer`.
 */
function fakeInstall({ version = "9.9.9", exportsField, main, entryBody } = {}) {
  const root = mkdtempSync(join(tmpdir(), "owc-meridian-"))
  mkdirSync(join(root, "dist"), { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@rynfar/meridian",
      version,
      type: "module",
      ...(main === undefined ? {} : { main }),
      ...(exportsField === undefined
        ? { exports: { ".": { types: "./dist/server.d.ts", default: "./dist/server.js" } } }
        : { exports: exportsField }),
    }),
  )
  writeFileSync(
    join(root, "dist", "server.js"),
    entryBody ?? "export function startProxyServer() { return Promise.resolve({}) }\n",
  )
  return root
}

test("no MERIDIAN_PATH: loads the bundled dependency", async () => {
  const { loadMeridian, describeMeridianSource } = await freshImport()
  const { log, logs } = collectLogs()

  const source = await withMeridianPath(undefined, () => loadMeridian(log))

  assert.equal(source.origin, "bundled")
  assert.equal(source.version, bundledVersion())
  assert.equal(typeof source.startProxyServer, "function")
  assert.equal(describeMeridianSource(source), `meridian ${bundledVersion()} (bundled)`)
  assert.deepEqual(logs, [], "the default path must not warn")
})

test("MERIDIAN_PATH pointing at a package root wins over the bundled copy", async () => {
  const root = fakeInstall({ version: "1.99.0" })
  try {
    const { loadMeridian, describeMeridianSource } = await freshImport()
    const source = await withMeridianPath(root, () => loadMeridian())

    assert.equal(source.origin, "external")
    assert.equal(source.version, "1.99.0")
    assert.equal(source.root, root)
    assert.equal(typeof source.startProxyServer, "function")
    assert.match(describeMeridianSource(source), /^meridian 1\.99\.0 \(external: /)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("MERIDIAN_PATH accepts the entry file itself", async () => {
  const root = fakeInstall({ version: "1.98.0" })
  try {
    const { loadMeridian } = await freshImport()
    const source = await withMeridianPath(join(root, "dist", "server.js"), () =>
      loadMeridian(),
    )

    assert.equal(source.origin, "external")
    assert.equal(source.version, "1.98.0", "version comes from the owning package root")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("MERIDIAN_PATH accepts a directory Node can resolve the package from", async () => {
  const root = fakeInstall({ version: "1.97.0" })
  const workspace = mkdtempSync(join(tmpdir(), "owc-global-"))
  try {
    const target = join(workspace, "node_modules", "@rynfar", "meridian")
    mkdirSync(dirname(target), { recursive: true })
    cpSync(root, target, { recursive: true })

    const { loadMeridian } = await freshImport()
    const source = await withMeridianPath(workspace, () => loadMeridian())

    assert.equal(source.origin, "external")
    assert.equal(source.version, "1.97.0")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("MERIDIAN_PATH falls back to `main` when there is no exports map", async () => {
  const root = fakeInstall({
    version: "1.96.0",
    exportsField: null,
    main: "./dist/server.js",
  })
  try {
    // `exportsField: null` would serialize a null exports key; drop it so the
    // manifest looks like an older package with only `main`.
    const manifestPath = join(root, "package.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    delete manifest.exports
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const { loadMeridian } = await freshImport()
    const source = await withMeridianPath(root, () => loadMeridian())

    assert.equal(source.origin, "external")
    assert.equal(source.version, "1.96.0")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a missing MERIDIAN_PATH warns and keeps the bundled copy", async () => {
  const { loadMeridian } = await freshImport()
  const { log, logs } = collectLogs()

  const source = await withMeridianPath(join(tmpdir(), "owc-does-not-exist"), () =>
    loadMeridian(log),
  )

  assert.equal(source.origin, "bundled")
  assert.equal(source.version, bundledVersion())
  assert.ok(
    logs.some((entry) => entry.level === "warn" && entry.message.includes("does not exist")),
    `expected a warning, got ${JSON.stringify(logs)}`,
  )
})

test("a build without startProxyServer warns and keeps the bundled copy", async () => {
  const root = fakeInstall({
    version: "1.95.0",
    entryBody: "export const nothingUseful = true\n",
  })
  try {
    const { loadMeridian } = await freshImport()
    const { log, logs } = collectLogs()

    const source = await withMeridianPath(root, () => loadMeridian(log))

    assert.equal(source.origin, "bundled")
    assert.ok(
      logs.some(
        (entry) =>
          entry.level === "warn" && entry.message.includes("does not export startProxyServer"),
      ),
      `expected a warning, got ${JSON.stringify(logs)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a directory that is not a Meridian install warns and keeps the bundled copy", async () => {
  const empty = mkdtempSync(join(tmpdir(), "owc-empty-"))
  try {
    const { loadMeridian } = await freshImport()
    const { log, logs } = collectLogs()

    const source = await withMeridianPath(empty, () => loadMeridian(log))

    assert.equal(source.origin, "bundled")
    assert.ok(
      logs.some((entry) => entry.level === "warn" && entry.message.includes("could not be resolved")),
      `expected a warning, got ${JSON.stringify(logs)}`,
    )
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
