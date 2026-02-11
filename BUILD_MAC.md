# MyKey macOS 应用构建指南

本指南将帮助您在 macOS 上构建和打包 MyKey 应用。

## 前置要求

### 1. 安装 Rust
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### 2. 安装 Node.js (推荐 v18+)
```bash
# 使用 Homebrew
brew install node
# 或从 https://nodejs.org 下载
```

### 3. 安装 Xcode Command Line Tools
```bash
xcode-select --install
```

## 构建步骤

### 1. 克隆或进入项目目录
```bash
cd /path/to/mykey
```

### 2. 安装依赖
```bash
npm install
```

### 3. 构建前端
```bash
npm run build
```

### 4. 构建 macOS 应用
```bash
npm run tauri:build
```

这个命令会：
- 编译 Rust 后端
- 打包前端资源
- 创建 macOS 应用包 (.app)
- 生成 DMG 安装程序 (可选)

### 5. 查找生成的应用

构建完成后，应用将位于：
```
src-tauri/target/release/bundle/macos/MyKey.app
```

DMG 安装程序 (如果生成) 将位于：
```
src-tauri/target/release/bundle/dmg/MyKey_*.dmg
```

## 运行应用

### 开发模式
```bash
npm run tauri:dev
```

### 生产模式
直接运行生成的 `.app` 文件：
```bash
open src-tauri/target/release/bundle/macos/MyKey.app
```

## 常见问题

### 问题 1: "command not found: cargo"
**解决方案**: 确保 Rust 已正确安装，并运行：
```bash
source $HOME/.cargo/env
```

### 问题 2: Xcode 相关错误
**解决方案**: 安装 Xcode Command Line Tools：
```bash
xcode-select --install
```

### 问题 3: 权限错误
**解决方案**: 确保项目目录有写入权限：
```bash
chmod -R u+w /path/to/mykey
```

### 问题 4: M1/M2 Mac 编译缓慢
**解决方案**: 这是正常的，首次编译可能需要 5-10 分钟。后续编译会快得多。

## 优化构建

### 为 Apple Silicon (M1/M2) 优化
```bash
rustup target add aarch64-apple-darwin
```

### 为 Intel Mac 优化
```bash
rustup target add x86_64-apple-darwin
```

### 构建通用二进制 (同时支持 Intel 和 Apple Silicon)
编辑 `src-tauri/tauri.conf.json`，在 `build` 部分添加：
```json
"targets": ["universal-apple-darwin"]
```

## 签名和公证 (可选)

如果要分发应用，需要进行代码签名和公证：

### 1. 获取开发者证书
访问 [Apple Developer](https://developer.apple.com) 获取证书。

### 2. 配置签名
编辑 `src-tauri/tauri.conf.json`：
```json
"bundle": {
  "macOS": {
    "signingIdentity": "YOUR_SIGNING_IDENTITY",
    "entitlements": "src-tauri/entitlements.plist"
  }
}
```

### 3. 构建和公证
```bash
npm run tauri:build
# 然后按照 Apple 的公证流程进行
```

## 发布

### 方式 1: 直接分发 .app
```bash
# 压缩应用
zip -r MyKey.zip src-tauri/target/release/bundle/macos/MyKey.app
# 上传到您的服务器或 GitHub Releases
```

### 方式 2: 使用 DMG 安装程序
DMG 文件会自动生成在 `src-tauri/target/release/bundle/dmg/` 目录中。

### 方式 3: 发布到 App Store (需要开发者账户)
参考 [Tauri macOS App Store 指南](https://tauri.app/v1/guides/distribution/sign-macos/)

## 调试

### 查看构建日志
```bash
npm run tauri:build -- --verbose
```

### 开发模式调试
```bash
npm run tauri:dev
```

### 检查应用信息
```bash
mdls src-tauri/target/release/bundle/macos/MyKey.app
```

## 更多帮助

- [Tauri 官方文档](https://tauri.app)
- [Tauri macOS 指南](https://tauri.app/v1/guides/distribution/sign-macos/)
- [Rust 官方文档](https://www.rust-lang.org/learn)

祝构建顺利！🚀
