// Runs the judge off the page's main thread, so a slow or hostile wasm cannot freeze the tab;
// app.js terminates this worker when it runs past its time limit.
import { runWasi } from "./wasi.js";

self.onmessage = async ({ data }) => {
  try {
    const module = await WebAssembly.compile(data.bytes);
    const { code, stdout } = runWasi(module, { stdin: new TextEncoder().encode(data.input), env: data.env });
    if (code !== 0) throw new Error(`judge exited with code ${code}`);
    self.postMessage({ text: new TextDecoder().decode(stdout) });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
