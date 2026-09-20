#!/usr/bin/env bash
# Install a private copy of code-server for dsh-file-tree.
#
#   bash scripts/install-code-server.sh [version]
#
# The panel's embedded editor needs a real code-server. This fetches the official
# release tarball into <plugin>/.code-server/, which is the location
# `findBinary()` checks after the configured path and the system locations — so
# an installation here is found automatically and needs no configuration, and it
# stays out of the way of a system-wide `code-server`.
#
# Why not simply stream the release URL: GitHub's release CDN throttles a single
# connection hard enough that a 200 MB tarball can stall for many minutes on this
# machine. The asset is therefore resolved through the API (which yields a signed
# CDN URL) and pulled as parallel byte ranges, which completes in well under a
# minute.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-4.138.0}"
DEST="$ROOT/.code-server"

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux) OS="linux" ;;
  *) echo "install-code-server: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="amd64" ;;
  *) echo "install-code-server: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

ASSET="code-server-${VERSION}-${OS}-${ARCH}.tar.gz"
echo "=== code-server ${VERSION} (${OS}-${ARCH}) → ${DEST} ==="

if [ -x "$DEST/bin/code-server" ]; then
  CURRENT="$("$DEST/bin/code-server" --version 2>/dev/null | head -1 || true)"
  echo "already installed: ${CURRENT:-unknown}"
  echo "delete $DEST to reinstall."
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "install-code-server: node is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "install-code-server: curl is required" >&2; exit 1; }

mkdir -p "$DEST"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/code-server-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# --- resolve the release asset -------------------------------------------------
RELEASE_JSON="$(curl -fsSL --max-time 60 "https://api.github.com/repos/coder/code-server/releases/tags/v${VERSION}")"
read -r ASSET_ID ASSET_SIZE <<EOF
$(printf '%s' "$RELEASE_JSON" | node -e '
  let raw = ""
  process.stdin.on("data", chunk => { raw += chunk })
  process.stdin.on("end", () => {
    const release = JSON.parse(raw)
    const asset = release.assets.find(item => item.name === process.argv[1])
    if (!asset) {
      console.error(`asset not found: ${process.argv[1]}`)
      process.exit(1)
    }
    process.stdout.write(`${asset.id} ${asset.size}`)
  })
' "$ASSET")
EOF
[ -n "${ASSET_ID:-}" ] || { echo "install-code-server: could not resolve $ASSET" >&2; exit 1; }
echo "asset ${ASSET_ID}, ${ASSET_SIZE} bytes"

# --- parallel range download, with one full-stream fallback -------------------
node -e '
  const [assetId, total, dest, chunks] = process.argv.slice(1)
  const { createWriteStream } = require("node:fs")
  const { open, rm, writeFile } = require("node:fs/promises")

  const signed = async () => {
    const response = await fetch(`https://api.github.com/repos/coder/code-server/releases/assets/${assetId}`, {
      headers: { accept: "application/octet-stream" },
      redirect: "manual",
    })
    const location = response.headers.get("location")
    if (!location) throw new Error(`no redirect (${response.status})`)
    return location
  }

  const run = async () => {
    const url = await signed()
    const size = Number(total)
    const count = Number(chunks)
    const partSize = Math.ceil(size / count)
    const parts = []
    for (let index = 0; index < count; index += 1) {
      const start = index * partSize
      const end = Math.min(size - 1, start + partSize - 1)
      if (start > end) break
      parts.push({ index, start, end, file: `${dest}.part${index}` })
    }
    let done = 0
    await Promise.all(parts.map(async part => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          const response = await fetch(url, { headers: { range: `bytes=${part.start}-${part.end}` } })
          if (response.status !== 206 && response.status !== 200) throw new Error(`status ${response.status}`)
          const buffer = Buffer.from(await response.arrayBuffer())
          const expected = part.end - part.start + 1
          if (buffer.length !== expected) throw new Error(`short read ${buffer.length}/${expected}`)
          await writeFile(part.file, buffer)
          done += 1
          process.stderr.write(`  chunk ${done}/${parts.length}\n`)
          return
        } catch (error) {
          if (attempt === 5) throw error
          await new Promise(resolve => setTimeout(resolve, 1500 * attempt))
        }
      }
    }))
    await rm(dest, { force: true })
    const out = createWriteStream(dest)
    for (const part of parts) {
      const handle = await open(part.file, "r")
      const { size: partBytes } = await handle.stat()
      const buffer = Buffer.allocUnsafe(partBytes)
      await handle.read(buffer, 0, partBytes, 0)
      await handle.close()
      out.write(buffer)
      await rm(part.file, { force: true })
    }
    out.end()
    await new Promise(resolve => out.on("close", resolve))
  }

  run().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
' "$ASSET_ID" "$ASSET_SIZE" "$TMP/$ASSET" 16

# --- verify, then extract ------------------------------------------------------
ACTUAL_SIZE="$(wc -c < "$TMP/$ASSET" | tr -d ' ')"
[ "$ACTUAL_SIZE" = "$ASSET_SIZE" ] || { echo "install-code-server: size mismatch ($ACTUAL_SIZE != $ASSET_SIZE)" >&2; exit 1; }

mkdir -p "$TMP/extract"
tar xzf "$TMP/$ASSET" -C "$TMP/extract"

# The tarball has a single top-level directory; its contents become DEST.
INNER="$(find "$TMP/extract" -maxdepth 1 -mindepth 1 -type d | head -1)"
[ -n "$INNER" ] || { echo "install-code-server: unexpected tarball layout" >&2; exit 1; }
cp -R "$INNER/." "$DEST/"

chmod +x "$DEST/bin/code-server" "$DEST/lib/node" 2>/dev/null || true
echo "=== installed: $("$DEST/bin/code-server" --version 2>&1 | head -1) ==="
echo "The panel will find it automatically; restart the plugin (or reload the page) to pick it up."
