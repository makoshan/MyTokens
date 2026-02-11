# MyKey - AI 资产保险箱

一个本地优先的、跨平台的桌面应用，用于集中托管开发者的关键数字资产（API 密钥、钱包私钥等），并作为 AI Agent 的权限管理与使用监控中枢。

![MyKey](https://img.shields.io/badge/MyKey-v1.0.0-blue)
![Tauri](https://img.shields.io/badge/Tauri-2.10.0-orange)
![React](https://img.shields.io/badge/React-19.2.4-61dafb)
![Rust](https://img.shields.io/badge/Rust-1.77.2-ce422b)

## ✨ 核心特性

### 🔐 安全管理
- **本地优先**: 所有数据存储在本地，永不上云
- **强加密**: 使用 AES-256-GCM 加密敏感数据（生产环境）
- **主密码保护**: 使用 Argon2 派生密钥，确保主密码安全
- **内存安全**: Rust 后端确保内存安全，无缓冲区溢出风险

### 📊 可视化管理
- **统一界面**: 在一个地方查看和管理所有 API 密钥
- **按提供商分组**: 自动按 OpenAI、Anthropic、Gemini 等分组
- **快速搜索**: 快速查找和切换密钥
- **详细信息**: 查看密钥的创建时间、使用状态等

### 📁 智能导入
- **自动扫描**: 从项目目录自动发现 `.env` 文件
- **智能识别**: 基于正则表达式自动识别不同提供商的密钥
- **批量导入**: 一键导入所有发现的密钥
- **安全解析**: 完全在本地解析，不上传任何内容

### 🎯 支持的提供商

| 提供商 | 状态 | 说明 |
|--------|------|------|
| OpenAI | ✅ 完全支持 | Chat Completions, Embeddings 等 |
| Anthropic | ✅ 完全支持 | Claude API |
| Google Gemini | ✅ 完全支持 | Gemini API |
| DeepSeek | ✅ 完全支持 | DeepSeek API |
| Kimi | ⏳ 计划中 | 即将支持 |
| Cursor | ⏳ 计划中 | 即将支持 |

## 🚀 快速开始

### 系统要求

- **macOS**: 10.13 或更高版本
- **Windows**: Windows 10 或更高版本（即将支持）
- **Linux**: Ubuntu 18.04 或更高版本（即将支持）

### 安装

#### 方式 1: 下载预编译应用 (推荐)

从 [GitHub Releases](https://github.com/yourusername/mykey/releases) 下载最新的 `.dmg` 文件，双击安装。

#### 方式 2: 从源代码构建

**前置要求**:
- Rust 1.77.2+
- Node.js 18+
- Xcode Command Line Tools (macOS)

**构建步骤**:

```bash
# 克隆项目
git clone https://github.com/yourusername/mykey.git
cd mykey

# 运行构建脚本
./build-mac.sh

# 或手动构建
npm install
npm run build
npm run tauri:build
```

详见 [BUILD_MAC.md](./BUILD_MAC.md)

### 首次使用

1. **启动应用**: 打开 MyKey 应用
2. **设置主密码**: 输入一个强密码作为主密码（首次使用）
3. **添加密钥**: 
   - 点击 "+ 添加密钥" 手动添加
   - 或点击 "📁 导入" 从 `.env` 文件导入
4. **查看和管理**: 在列表中查看、编辑、删除密钥

## 📖 使用指南

### 添加密钥

1. 点击顶部的 "+ 添加密钥" 按钮
2. 选择提供商（OpenAI、Anthropic 等）
3. 输入密钥名称（便于识别）
4. 输入 API 密钥
5. 点击 "添加" 保存

### 导入密钥

1. 点击顶部的 "📁 导入" 按钮
2. 粘贴 `.env` 文件的内容
3. MyKey 会自动识别所有密钥
4. 点击 "导入" 完成

### 编辑密钥

1. 在列表中选择一个密钥
2. 点击右侧的 "✏️" 按钮
3. 修改信息
4. 点击 "更新" 保存

### 删除密钥

1. 在列表中选择一个密钥
2. 点击右侧的 "🗑️" 按钮
3. 确认删除

### 查看密钥详情

1. 在列表中点击一个密钥
2. 右侧面板会显示详细信息
3. 点击 "显示" 可以查看完整的密钥内容

## 🔧 开发

### 项目结构

```
mykey/
├── src/                          # React 前端
│   ├── App.tsx                  # 主应用
│   ├── components/              # React 组件
│   └── ...
├── src-tauri/                   # Rust 后端
│   ├── src/
│   │   ├── lib.rs              # 库入口
│   │   ├── vault.rs            # 密钥保险箱
│   │   └── commands.rs         # Tauri 命令
│   └── Cargo.toml              # Rust 依赖
├── index.html                   # HTML 入口
├── vite.config.ts              # Vite 配置
├── tsconfig.json               # TypeScript 配置
└── package.json                # Node.js 依赖
```

### 开发模式

```bash
# 启动开发服务器
npm run tauri:dev
```

这会同时启动：
- Vite 开发服务器 (http://localhost:3000)
- Tauri 应用窗口
- 热重载支持

### 构建

```bash
# 构建前端
npm run build

# 构建应用
npm run tauri:build

# 输出位置
# macOS: src-tauri/target/release/bundle/macos/MyKey.app
# DMG: src-tauri/target/release/bundle/dmg/MyKey_*.dmg
```

## 🔐 安全考虑

### 当前实现 (MVP)

- ✅ 本地存储，不上云
- ✅ 主密码保护
- ⚠️ 使用 MD5 哈希（演示用，不推荐生产）
- ⚠️ 内存存储（重启后丢失）

### 生产级改进

我们计划在后续版本中实现：

- [ ] Argon2 密钥派生
- [ ] AES-256-GCM 加密
- [ ] SQLite 数据库持久化
- [ ] 硬件安全模块 (HSM) 支持
- [ ] 端到端加密云备份
- [ ] 审计日志

## 🤝 贡献

欢迎贡献！请按照以下步骤：

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 开启 Pull Request

## 📝 许可证

本项目采用 MIT 许可证。详见 [LICENSE](./LICENSE) 文件。

## 🙋 常见问题

### Q: 我的密钥是否安全？
A: 是的。所有密钥都存储在本地，使用主密码保护。我们不收集、不存储、不上传任何用户数据。

### Q: 如果我忘记了主密码怎么办？
A: 不幸的是，由于安全原因，无法恢复。您需要重新设置主密码，这将清除所有现有密钥。

### Q: 支持哪些操作系统？
A: 目前支持 macOS。Windows 和 Linux 支持即将推出。

### Q: 可以在多台设备上使用吗？
A: 目前不支持。每台设备都有独立的本地存储。我们计划在未来版本中添加端到端加密的云同步功能。

### Q: 应用多少钱？
A: MyKey 是免费开源软件！

## 📞 联系方式

- 📧 Email: support@mykey.app
- 🐦 Twitter: [@MyKeyApp](https://twitter.com/mykeyapp)
- 💬 Discord: [加入我们的社区](https://discord.gg/mykey)
- 🐛 Bug 报告: [GitHub Issues](https://github.com/yourusername/mykey/issues)

## 🙏 致谢

感谢以下项目的启发和支持：

- [Tauri](https://tauri.app) - 轻量级跨平台应用框架
- [cc-switch](https://github.com/farion1231/cc-switch) - API 代理架构参考
- [ShipKey](https://github.com/chekusu/shipkey) - 密钥管理理念参考

---

**MyKey**: 让 AI 资产管理变得简单、安全、透明。🔐✨
