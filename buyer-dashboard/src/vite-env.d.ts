/// <reference types="vite/client" />

declare module '*.wasm?url' {
  const url: string
  export default url
}
declare module '@consenlabs/tcx-wasm/tcx_wasm_bg.wasm?url' {
  const url: string
  export default url
}
