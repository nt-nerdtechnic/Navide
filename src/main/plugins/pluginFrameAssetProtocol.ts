import { randomBytes } from 'node:crypto'
import { realpath, readFile, stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'

export const PLUGIN_FRAME_SCHEME = 'navide-plugin-frame'

export type PluginFrameAssetMount = {
  artifactId: string
  packageId: string
  packageVersion: string
  root: string
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

const FRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'none'",
].join('; ')

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !path.includes(`..${sep}`)
}

function response(status: number): Response {
  return new Response(null, { status })
}

/** Maps one verified package artifact to one unguessable, revocable frame origin. */
export class PluginFrameAssetProtocol {
  private readonly mounts = new Map<string, PluginFrameAssetMount & { canonicalRoot: string }>()

  async mount(mount: PluginFrameAssetMount): Promise<string> {
    const canonicalRoot = await realpath(mount.root)
    const hostname = randomBytes(32).toString('hex')
    this.mounts.set(hostname, { ...mount, canonicalRoot })
    return `${PLUGIN_FRAME_SCHEME}://${hostname}/`
  }

  revoke(origin: string): void {
    try {
      const hostname = new URL(origin).hostname
      this.mounts.delete(hostname)
    } catch {
      // Invalid origins cannot name a mount.
    }
  }

  async handle(request: Request): Promise<Response> {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return response(400)
    }
    if (url.protocol !== `${PLUGIN_FRAME_SCHEME}:` || request.method !== 'GET') return response(404)
    const mount = this.mounts.get(url.hostname)
    if (!mount || url.username || url.password || url.port || url.search || url.hash) return response(404)

    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(url.pathname)
    } catch {
      return response(400)
    }
    if (!decodedPath.startsWith('/') || decodedPath.includes('\\') || decodedPath.includes('\0')) return response(404)
    const candidate = resolve(mount.canonicalRoot, `.${decodedPath}`)
    if (!isWithin(mount.canonicalRoot, candidate)) return response(404)

    let canonicalFile: string
    try {
      canonicalFile = await realpath(candidate)
      if (!isWithin(mount.canonicalRoot, canonicalFile) || !(await stat(canonicalFile)).isFile()) return response(404)
    } catch {
      return response(404)
    }
    const contentType = MIME_TYPES[extname(canonicalFile).toLowerCase()]
    if (!contentType) return response(404)
    try {
      return new Response(await readFile(canonicalFile), {
        headers: {
          'Content-Security-Policy': FRAME_CSP,
          'Content-Type': contentType,
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return response(404)
    }
  }
}
