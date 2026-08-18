// 组合包入口：重新导出插件的 name/inject/Config/apply，由 cordis loader 挂载。
// 具体逻辑在 src/ 下，src 子模块通过相对路径引用，依赖走本包 package.json 声明。

export { name, inject, Config, apply } from './src/index.mjs'