/**
 * Decide which Meridian build backs the proxy.
 *
 * The plugin depends on an exact `@rynfar/meridian` version, so by default it
 * runs the copy that shipped with the release. Meridian moves faster than this
 * plugin does, and its auth, profiles, and session cache already live on disk
 * (`~/.config/meridian`, `~/.cache/meridian`), so nothing but the code version
 * differs between the bundled copy and a CLI install. `MERIDIAN_PATH` lets a
 * user point the plugin at that install and follow Meridian's releases without
 * waiting for a plugin release.
 *
 * The bundled copy is always the fallback: a missing path, an unreadable
 * package, or a build that does not export `startProxyServer` logs a warning
 * and changes nothing else.
 *
 * Leaf module: no imports from proxy.ts or index.ts.
 */

import { existsSync, readFileSync, statSync } from "fs"
import { createRequire } from "module"
import { homedir } from "os"
import { dirname, join, resolve } from "path"
import { pathToFileURL } from "url"

import type { LogFn } from "./logger.ts"

export const MERIDIAN_PACKAGE = "@rynfar/meridian"

/** The one entry point the plugin uses; a swapped build must still have it. */
export type StartProxyServer = typeof import("@rynfar/meridian")["startProxyServer"]

export interface MeridianSource {
  startProxyServer: StartProxyServer
  /** Which copy won: the dependency, or a build named by `MERIDIAN_PATH`. */
  origin: "bundled" | "external"
  /** Package root of the resolved build, when it could be determined. */
  root?: string
  version?: string
}

/** How far up from an entry file to look for the owning package.json. */
const MAX_PACKAGE_DEPTH = 5

interface Manifest {
  name?: unknown
  version?: unknown
  main?: unknown
  exports?: unknown
}

function warn(log: LogFn | undefined, message: string): void {
  void log?.("warn", `[opencode-with-claude] ${message}`)
}

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2))
  }
  return path
}

function readManifest(dir: string): Manifest | undefined {
  const file = join(dir, "package.json")
  if (!existsSync(file)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Manifest)
      : undefined
  } catch {
    return undefined
  }
}

function manifestVersion(manifest: Manifest | undefined): string | undefined {
  return typeof manifest?.version === "string" ? manifest.version : undefined
}

/** Walk up from `dir` to the package root that owns it. */
export function findPackageRoot(dir: string): string | undefined {
  let current = dir
  for (let depth = 0; depth < MAX_PACKAGE_DEPTH; depth++) {
    if (readManifest(current)?.name === MERIDIAN_PACKAGE) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * Pick the ESM entry a package root exposes. Meridian declares only `"."` in
 * its exports map, so the conditions worth checking are few; `main` covers
 * older layouts.
 */
export function resolveEntryFromManifest(
  root: string,
  manifest: Manifest,
): string | undefined {
  const dot = (manifest.exports as Record<string, unknown> | undefined)?.["."]

  const fromConditions = (value: unknown): string | undefined => {
    if (typeof value === "string") return value
    if (typeof value !== "object" || value === null) return undefined
    const conditions = value as Record<string, unknown>
    for (const key of ["import", "module", "node", "default"]) {
      const candidate = fromConditions(conditions[key])
      if (candidate) return candidate
    }
    return undefined
  }

  const relative =
    fromConditions(dot) ??
    (typeof manifest.exports === "string" ? manifest.exports : undefined) ??
    (typeof manifest.main === "string" ? manifest.main : undefined)

  if (!relative) return undefined
  const entry = resolve(root, relative)
  return existsSync(entry) ? entry : undefined
}

interface ResolvedBuild {
  entry: string
  root?: string
}

/**
 * Turn a user-supplied `MERIDIAN_PATH` into an importable entry file.
 *
 * Accepts the three shapes a user is likely to have on hand: the entry file
 * itself, the Meridian package root, or any directory Node can resolve
 * `@rynfar/meridian` from (a global `node_modules`, or a project that depends
 * on it).
 */
export function resolveExternalMeridian(
  rawPath: string,
  log?: LogFn,
): ResolvedBuild | undefined {
  const target = resolve(expandHome(rawPath.trim()))

  if (!existsSync(target)) {
    warn(log, `MERIDIAN_PATH "${rawPath}" does not exist; using the bundled Meridian.`)
    return undefined
  }

  if (statSync(target).isFile()) {
    return { entry: target, root: findPackageRoot(dirname(target)) }
  }

  // A package root, or a checkout laid out like one.
  for (const dir of [target, join(target, MERIDIAN_PACKAGE)]) {
    const manifest = readManifest(dir)
    if (manifest?.name !== MERIDIAN_PACKAGE) continue
    const entry = resolveEntryFromManifest(dir, manifest)
    if (entry) return { entry, root: dir }
    warn(log, `Meridian package at "${dir}" declares no usable entry point.`)
    return undefined
  }

  // Anything Node itself can resolve the package from.
  try {
    const entry = createRequire(join(target, "package.json")).resolve(
      MERIDIAN_PACKAGE,
    )
    return { entry, root: findPackageRoot(dirname(entry)) }
  } catch {
    warn(
      log,
      `MERIDIAN_PATH "${rawPath}" is not a Meridian install and ${MERIDIAN_PACKAGE} could not be resolved from it; using the bundled Meridian.`,
    )
    return undefined
  }
}

function asStartProxyServer(module: unknown): StartProxyServer | undefined {
  if (typeof module !== "object" || module === null) return undefined
  const candidate = (module as Record<string, unknown>).startProxyServer
  return typeof candidate === "function"
    ? (candidate as StartProxyServer)
    : undefined
}

async function loadExternal(
  rawPath: string,
  log: LogFn | undefined,
): Promise<MeridianSource | undefined> {
  const build = resolveExternalMeridian(rawPath, log)
  if (!build) return undefined

  try {
    const module: unknown = await import(pathToFileURL(build.entry).href)
    const startProxyServer = asStartProxyServer(module)
    if (!startProxyServer) {
      warn(
        log,
        `Meridian at "${build.entry}" does not export startProxyServer; using the bundled Meridian.`,
      )
      return undefined
    }
    return {
      startProxyServer,
      origin: "external",
      root: build.root,
      version: build.root ? manifestVersion(readManifest(build.root)) : undefined,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn(
      log,
      `failed to load Meridian from "${build.entry}": ${msg}. Using the bundled Meridian.`,
    )
    return undefined
  }
}

/**
 * Read the bundled Meridian's version.
 *
 * Meridian reports the literal string `"unknown"` on /health unless the host
 * passes a version in: its CLI reads its own package.json, but a library
 * consumer such as this plugin has to do the same. Without it, /health, the
 * dashboard, and any external monitor all report `"unknown"`.
 *
 * The manifest cannot be resolved as a subpath — Meridian's `exports` map only
 * declares `"."`, so `require.resolve("@rynfar/meridian/package.json")` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the entry point instead and walk up to
 * the owning package root. Returns undefined if anything is unexpected, which
 * simply leaves Meridian's own fallback in place.
 */
export function resolveMeridianVersion(): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve(MERIDIAN_PACKAGE)
    const root = findPackageRoot(dirname(entry))
    return root ? manifestVersion(readManifest(root)) : undefined
  } catch {
    return undefined
  }
}

async function loadBundled(): Promise<MeridianSource> {
  // Literal specifier: the bundler has to see it to keep the dependency
  // external and resolvable from `dist/`.
  const module: unknown = await import("@rynfar/meridian")
  const startProxyServer = asStartProxyServer(module)
  if (!startProxyServer) {
    throw new Error(`${MERIDIAN_PACKAGE} does not export startProxyServer`)
  }
  return {
    startProxyServer,
    origin: "bundled",
    version: resolveMeridianVersion(),
  }
}

/**
 * Load Meridian: the build named by `MERIDIAN_PATH` when it is usable, the
 * bundled dependency otherwise.
 */
export async function loadMeridian(log?: LogFn): Promise<MeridianSource> {
  const configured = process.env.MERIDIAN_PATH?.trim()
  if (configured) {
    const external = await loadExternal(configured, log)
    if (external) return external
  }
  return loadBundled()
}

/** One-line startup log describing which build is running. */
export function describeMeridianSource(source: MeridianSource): string {
  const version = source.version ?? "unknown version"
  if (source.origin === "bundled") return `meridian ${version} (bundled)`
  return `meridian ${version} (external: ${source.root ?? "MERIDIAN_PATH"})`
}
