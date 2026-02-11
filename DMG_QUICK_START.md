# MyKey DMG 快速开始指南

## ⚡ 最快的方式 (3 步)

### 1. 在 Mac 上打开终端，进入项目目录

```bash
cd /path/to/mykey
```

### 2. 运行构建脚本

```bash
./build-dmg.sh
```

### 3. 等待构建完成

脚本会自动：
- ✅ 检查所有前置条件
- ✅ 安装 npm 依赖
- ✅ 构建前端
- ✅ 构建 DMG 文件

## 📍 查找生成的 DMG

构建完成后，DMG 文件位于：

```
src-tauri/target/release/bundle/dmg/MyKey_*.dmg
```

## 🧪 测试 DMG

### 挂载 DMG

```bash
hdiutil attach src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg
```

### 安装应用

从 Finder 中的 MyKey 卷，拖动 MyKey.app 到 Applications 文件夹

### 启动应用

```bash
open /Applications/MyKey.app
```

### 卸载 DMG

```bash
hdiutil detach /Volumes/MyKey
```

## 📦 分发 DMG

### 上传到 GitHub

```bash
# 创建 release
gh release create v1.0.0 \
  src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg
```

### 上传到服务器

```bash
scp src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg \
  user@your-server.com:/var/www/downloads/
```

## 🆘 常见问题

| 问题 | 解决方案 |
|------|--------|
| "command not found: cargo" | 运行 `source $HOME/.cargo/env` |
| 构建很慢 | 首次构建需要 5-15 分钟，这是正常的 |
| 找不到 DMG 文件 | 检查 `src-tauri/target/release/bundle/dmg/` 目录 |
| 应用无法启动 | 检查 macOS 版本是否为 10.13 或更高 |

## 📖 详细指南

更多信息请查看：
- [DMG_BUILD_GUIDE.md](./DMG_BUILD_GUIDE.md) - 完整的 DMG 构建指南
- [BUILD_MAC.md](./BUILD_MAC.md) - macOS 构建指南
- [README.md](./README.md) - 项目概览

## 💡 提示

- 首次构建会比较慢，后续构建会快得多
- 如果遇到问题，查看 `DMG_BUILD_GUIDE.md` 中的故障排除部分
- 可以通过编辑 `src-tauri/tauri.conf.json` 自定义 DMG 外观

---

祝您成功构建 DMG！🚀
