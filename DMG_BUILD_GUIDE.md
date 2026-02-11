# MyKey DMG 打包完整指南

本指南将帮助您在 macOS 上生成专业的 DMG 安装程序。

## 📋 前置要求

### 1. 系统要求
- **macOS**: 10.13 或更高版本
- **Xcode**: 12.0 或更高版本
- **Xcode Command Line Tools**: 已安装

### 2. 开发工具
- **Rust**: 1.77.2 或更高版本
- **Node.js**: 18 或更高版本
- **npm**: 9 或更高版本

### 3. 验证安装

```bash
# 检查 Rust
rustc --version
cargo --version

# 检查 Node.js
node --version
npm --version

# 检查 Xcode Command Line Tools
xcode-select -p
# 应该输出: /Applications/Xcode.app/Contents/Developer
```

## 🎨 准备应用图标

DMG 需要高质量的应用图标。建议准备以下规格：

### 图标文件

```
src-tauri/icons/
├── icon.icns           # macOS 应用图标 (必需)
├── icon.ico            # Windows 图标 (可选)
├── 32x32.png          # 32x32 PNG
├── 128x128.png        # 128x128 PNG
├── 128x128@2x.png     # Retina 显示屏 (256x256)
└── Square150x150Logo.png  # Windows (可选)
```

### 生成 ICNS 文件

如果您还没有 `.icns` 文件，可以这样生成：

```bash
# 方式 1: 使用在线工具
# 访问 https://icoconvert.com/ 上传 PNG 文件转换为 ICNS

# 方式 2: 使用 ImageMagick
brew install imagemagick
convert icon.png -define icon:auto-resize=256,128,96,64,48,32,16 icon.icns

# 方式 3: 使用 sips (macOS 内置)
sips -s format icns icon.png --out icon.icns
```

## 🔨 构建 DMG

### 方式 1: 使用自动构建脚本 (推荐)

```bash
cd /path/to/mykey
./build-dmg.sh
```

### 方式 2: 手动构建

```bash
# 1. 进入项目目录
cd /path/to/mykey

# 2. 安装依赖
npm install

# 3. 构建前端
npm run build

# 4. 构建 DMG
npm run tauri:build -- --target universal-apple-darwin

# 或仅为当前架构构建
npm run tauri:build
```

### 方式 3: 使用 Tauri CLI 直接构建

```bash
cd src-tauri
cargo tauri build --target universal-apple-darwin
```

## 📦 DMG 输出位置

构建完成后，您将找到：

```
src-tauri/target/release/bundle/
├── dmg/
│   ├── MyKey_1.0.0_universal.dmg    # 通用二进制 (Intel + Apple Silicon)
│   ├── MyKey_1.0.0_aarch64.dmg      # Apple Silicon 专用
│   └── MyKey_1.0.0_x86_64.dmg       # Intel 专用
└── macos/
    └── MyKey.app                     # 应用包
```

## ✅ 验证 DMG

### 1. 检查文件大小

```bash
ls -lh src-tauri/target/release/bundle/dmg/*.dmg
```

典型大小：
- 通用二进制: 50-100 MB
- 单架构: 30-50 MB

### 2. 挂载 DMG 测试

```bash
# 挂载 DMG
hdiutil attach src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg

# 应该在 Finder 中看到 MyKey 卷
# 尝试拖动应用到 Applications 文件夹

# 卸载 DMG
hdiutil detach /Volumes/MyKey
```

### 3. 测试应用安装

```bash
# 从 DMG 中复制应用
cp -r /Volumes/MyKey/MyKey.app /Applications/

# 启动应用
open /Applications/MyKey.app

# 验证应用是否正常运行
```

## 🔐 代码签名 (可选但推荐)

如果要分发应用，建议进行代码签名和公证。

### 1. 获取开发者证书

访问 [Apple Developer](https://developer.apple.com) 获取：
- Apple Development 证书
- Developer ID Application 证书
- Developer ID Installer 证书

### 2. 配置签名

编辑 `src-tauri/tauri.conf.json`：

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: Your Name (TEAM_ID)",
      "providerShortTeamId": "TEAM_ID"
    }
  }
}
```

### 3. 构建并签名

```bash
npm run tauri:build
```

### 4. 验证签名

```bash
codesign -v /Applications/MyKey.app
spctl -a -v /Applications/MyKey.app
```

## 📤 公证应用 (可选)

如果要在 macOS 10.15+ 上分发，需要进行公证。

### 1. 创建应用专用密码

访问 [Apple ID](https://appleid.apple.com/account/security) 创建应用专用密码。

### 2. 保存凭证

```bash
xcrun notarytool store-credentials "MyKey-Notary" \
  --apple-id "your-email@example.com" \
  --team-id "TEAM_ID" \
  --password "app-specific-password"
```

### 3. 公证应用

```bash
# 公证 DMG
xcrun notarytool submit src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg \
  --keychain-profile "MyKey-Notary" \
  --wait

# 获取公证凭证
xcrun stapler staple /Applications/MyKey.app
```

## 🎨 自定义 DMG 外观

### 编辑 DMG 背景

1. 创建一个 PNG 背景图像 (600x400 像素)
2. 保存到 `src-tauri/icons/dmg-background.png`
3. 编辑 `tauri.conf.json`:

```json
{
  "bundle": {
    "dmg": {
      "background": "icons/dmg-background.png"
    }
  }
}
```

### 自定义 DMG 布局

编辑 `tauri.conf.json` 中的 `dmg.contents`:

```json
{
  "bundle": {
    "dmg": {
      "contents": [
        {
          "x": 200,
          "y": 190,
          "type": "file",
          "path": "MyKey.app"
        },
        {
          "x": 400,
          "y": 190,
          "type": "link",
          "path": "/Applications"
        },
        {
          "x": 300,
          "y": 350,
          "type": "file",
          "path": "README.md"
        }
      ]
    }
  }
}
```

## 🚀 分发 DMG

### 1. 上传到 GitHub Releases

```bash
# 创建 GitHub release
gh release create v1.0.0 \
  src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg \
  --title "MyKey v1.0.0" \
  --notes "First release of MyKey"
```

### 2. 上传到自己的服务器

```bash
# 使用 scp
scp src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg \
  user@your-server.com:/var/www/downloads/

# 或使用 rsync
rsync -avz src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg \
  user@your-server.com:/var/www/downloads/
```

### 3. 创建下载页面

```html
<a href="https://your-domain.com/downloads/MyKey_1.0.0_universal.dmg">
  下载 MyKey v1.0.0 (macOS)
</a>
```

## 📊 DMG 文件信息

### 查看 DMG 详情

```bash
# 显示 DMG 信息
hdiutil imageinfo src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg

# 显示 DMG 大小
du -h src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg

# 验证 DMG 完整性
hdiutil verify src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg
```

## 🆘 常见问题

### Q: DMG 构建失败

**解决方案**:
1. 确保前端已成功构建: `npm run build`
2. 检查 Rust 工具链: `rustup update`
3. 清理构建缓存: `cargo clean`
4. 重新构建: `npm run tauri:build`

### Q: DMG 太大

**解决方案**:
1. 启用压缩: 编辑 `tauri.conf.json`，添加 `"compression": "bzip2"`
2. 移除不必要的依赖
3. 使用通用二进制而不是单架构

### Q: 应用无法从 DMG 启动

**解决方案**:
1. 检查代码签名: `codesign -v MyKey.app`
2. 检查权限: `ls -la MyKey.app`
3. 查看系统日志: `log show --predicate 'process == "MyKey"'`

### Q: DMG 挂载后无法拖动应用

**解决方案**:
1. 检查 DMG 配置中的坐标
2. 重新生成 DMG
3. 使用 Finder 手动调整布局

## 📚 参考资源

- [Tauri 官方文档](https://tauri.app)
- [macOS 应用分发指南](https://developer.apple.com/macos/distribution/)
- [Apple 公证指南](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)

## ✨ 最佳实践

1. **版本管理**: 在 `tauri.conf.json` 中更新版本号
2. **变更日志**: 为每个版本创建 CHANGELOG
3. **测试**: 在真实 Mac 上测试 DMG 安装
4. **签名**: 对分发的应用进行代码签名
5. **公证**: 对公开分发的应用进行公证
6. **文档**: 提供清晰的安装和使用说明

---

祝您成功构建和分发 MyKey！🚀
