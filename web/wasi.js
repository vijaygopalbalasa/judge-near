// A minimal WASI preview 1 host, just enough to run the judge in a browser or in Node.
//
// The judge imports exactly five functions (environ_get, environ_sizes_get, fd_read, fd_write,
// proc_exit; see judge-wasm/BUILD.md). They are implemented here in a few lines each, so anyone
// can read the whole host the verdict depends on. Any other import answers ENOSYS.

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;

class ProcExit {
  constructor(code) {
    this.code = code;
  }
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Run a wasm32-wasip1 command module once.
 * @param {WebAssembly.Module} module compiled judge
 * @param {{stdin?: Uint8Array, env?: Record<string, string>}} options
 * @returns {{code: number, stdout: Uint8Array, stderr: Uint8Array}}
 */
export function runWasi(module, { stdin = new Uint8Array(0), env = {} } = {}) {
  const encoder = new TextEncoder();
  const envEntries = Object.entries(env).map(([k, v]) => encoder.encode(`${k}=${v}\0`));
  const stdout = [];
  const stderr = [];
  let stdinAt = 0;
  let memory;

  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);

  const host = {
    environ_sizes_get(countPtr, sizePtr) {
      view().setUint32(countPtr, envEntries.length, true);
      view().setUint32(sizePtr, envEntries.reduce((n, e) => n + e.length, 0), true);
      return ERRNO_SUCCESS;
    },
    environ_get(environPtr, bufPtr) {
      let at = bufPtr;
      envEntries.forEach((entry, i) => {
        view().setUint32(environPtr + i * 4, at, true);
        bytes().set(entry, at);
        at += entry.length;
      });
      return ERRNO_SUCCESS;
    },
    fd_read(fd, iovs, iovsLen, nreadPtr) {
      if (fd !== 0) return ERRNO_BADF;
      let read = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        const chunk = stdin.subarray(stdinAt, stdinAt + len);
        bytes().set(chunk, ptr);
        stdinAt += chunk.length;
        read += chunk.length;
        if (chunk.length < len) break;
      }
      view().setUint32(nreadPtr, read, true);
      return ERRNO_SUCCESS;
    },
    fd_write(fd, iovs, iovsLen, nwrittenPtr) {
      if (fd !== 1 && fd !== 2) return ERRNO_BADF;
      let written = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        (fd === 1 ? stdout : stderr).push(bytes().slice(ptr, ptr + len));
        written += len;
      }
      view().setUint32(nwrittenPtr, written, true);
      return ERRNO_SUCCESS;
    },
    proc_exit(code) {
      throw new ProcExit(code);
    },
  };

  const imports = {
    wasi_snapshot_preview1: new Proxy(host, { get: (target, name) => target[name] ?? (() => ERRNO_NOSYS) }),
  };
  const instance = new WebAssembly.Instance(module, imports);
  memory = instance.exports.memory;
  let code = 0;
  try {
    instance.exports._start();
  } catch (e) {
    if (e instanceof ProcExit) code = e.code;
    else throw e;
  }
  return { code, stdout: concat(stdout), stderr: concat(stderr) };
}
