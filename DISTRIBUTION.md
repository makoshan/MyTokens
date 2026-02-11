# MyKey DMG 分发指南

本指南将帮助您将 MyKey DMG 分发给用户。

## 📦 准备分发

### 1. 构建 DMG

```bash
./build-dmg.sh
```

### 2. 验证 DMG

```bash
# 检查文件大小
ls -lh src-tauri/target/release/bundle/dmg/MyKey_*.dmg

# 验证完整性
hdiutil verify src-tauri/target/release/bundle/dmg/MyKey_*.dmg

# 测试挂载
hdiutil attach src-tauri/target/release/bundle/dmg/MyKey_*.dmg
hdiutil detach /Volumes/MyKey
```

### 3. 创建校验和 (可选但推荐)

```bash
# 生成 SHA256 校验和
shasum -a 256 src-tauri/target/release/bundle/dmg/MyKey_*.dmg > MyKey_1.0.0.sha256

# 用户可以验证：
shasum -a 256 -c MyKey_1.0.0.sha256
```

## 🌐 分发渠道

### 方式 1: GitHub Releases (推荐)

#### 前置要求
- GitHub 账户
- GitHub CLI 已安装

#### 步骤

```bash
# 1. 创建 GitHub 仓库 (如果还没有)
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/mykey.git
git push -u origin main

# 2. 创建 release
gh release create v1.0.0 \
  src-tauri/target/release/bundle/dmg/MyKey_1.0.0_universal.dmg \
  MyKey_1.0.0.sha256 \
  --title "MyKey v1.0.0" \
  --notes "First release of MyKey - AI Asset Vault"

# 3. 发布 release
gh release edit v1.0.0 --draft=false
```

#### Release 说明模板

```markdown
# MyKey v1.0.0

## ✨ 新功能

- 🔐 安全的本地密钥管理
- 📊 可视化密钥查看和编辑
- 📁 智能导入 .env 文件
- 🔑 支持 OpenAI、Anthropic、Gemini 等

## 📥 下载

- **MyKey_1.0.0_universal.dmg** - 通用版本 (Intel + Apple Silicon)
- **SHA256**: `[校验和]`

## 📋 系统要求

- macOS 10.13 或更高版本
- 50 MB 可用磁盘空间

## 🚀 快速开始

1. 下载 DMG 文件
2. 双击打开
3. 拖动 MyKey 到 Applications 文件夹
4. 启动应用

## 🐛 已知问题

无

## 🙏 致谢

感谢所有贡献者和用户的支持！

---

[更多信息](https://github.com/yourusername/mykey)
```

### 方式 2: 自己的网站

#### 创建下载页面

```html
<!DOCTYPE html>
<html>
<head>
    <title>MyKey - 下载</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }
        .download-btn {
            display: inline-block;
            background: #007AFF;
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            text-decoration: none;
            margin: 10px 0;
        }
        .download-btn:hover {
            background: #0051D5;
        }
    </style>
</head>
<body>
    <h1>MyKey - 下载</h1>
    <p>AI 资产保险箱，本地优先的密钥管理工具</p>
    
    <h2>macOS</h2>
    <p>
        <a href="/downloads/MyKey_1.0.0_universal.dmg" class="download-btn">
            下载 MyKey v1.0.0 (macOS)
        </a>
    </p>
    <p>
        <small>
            大小: 75 MB | 
            SHA256: <code>abc123...</code>
        </small>
    </p>
    
    <h3>系统要求</h3>
    <ul>
        <li>macOS 10.13 或更高版本</li>
        <li>50 MB 可用磁盘空间</li>
    </ul>
    
    <h3>安装步骤</h3>
    <ol>
        <li>下载 DMG 文件</li>
        <li>双击打开</li>
        <li>拖动应用到 Applications 文件夹</li>
        <li>启动应用</li>
    </ol>
</body>
</html>
```

#### 上传到服务器

```bash
# 使用 scp
scp src-tauri/target/release/bundle/dmg/MyKey_*.dmg \
    user@your-domain.com:/var/www/downloads/

# 使用 rsync
rsync -avz src-tauri/target/release/bundle/dmg/MyKey_*.dmg \
    user@your-domain.com:/var/www/downloads/

# 更新网站
scp index.html user@your-domain.com:/var/www/downloads/
```

### 方式 3: Homebrew (高级)

#### 创建 Homebrew Formula

```bash
# 1. 创建 formula 文件
mkdir -p Formula
cat > Formula/mykey.rb << 'EOF'
class Mykey < Formula
  desc "AI Asset Vault - Local-first key management"
  homepage "https://github.com/yourusername/mykey"
  url "https://github.com/yourusername/mykey/releases/download/v1.0.0/MyKey_1.0.0_universal.dmg"
  sha256 "abc123..."
  version "1.0.0"

  def install
    app = staged_path/"MyKey.app"
    (staged_path/"MyKey.app").mkpath
    system "hdiutil", "attach", cached_download, "-readonly", "-mountpoint", mount_point
    cp_r "#{mount_point}/MyKey.app", app
    system "hdiutil", "detach", mount_point
    prefix.install app
  end

  def cask_url
    "https://github.com/yourusername/mykey/releases/download/v1.0.0/MyKey_1.0.0_universal.dmg"
  end
end
EOF

# 2. 创建 Homebrew Cask (更简单)
mkdir -p Casks
cat > Casks/mykey.rb << 'EOF'
cask "mykey" do
  version "1.0.0"
  sha256 "abc123..."
  url "https://github.com/yourusername/mykey/releases/download/v#{version}/MyKey_#{version}_universal.dmg"
  name "MyKey"
  desc "AI Asset Vault - Local-first key management"
  homepage "https://github.com/yourusername/mykey"
  app "MyKey.app"
end
EOF
```

#### 发布到 Homebrew

```bash
# 1. Fork homebrew-cask
# https://github.com/Homebrew/homebrew-cask

# 2. 提交 PR
git clone https://github.com/yourusername/homebrew-cask
cd homebrew-cask
git checkout -b mykey-cask
cp ../Casks/mykey.rb Casks/
git add Casks/mykey.rb
git commit -m "Add MyKey cask"
git push origin mykey-cask

# 3. 创建 Pull Request
```

用户可以通过以下方式安装：
```bash
brew install mykey
```

### 方式 4: MacUpdate 或 VersionTracker

1. 访问 [MacUpdate](https://www.macupdate.com)
2. 提交应用
3. 等待审核

## 📊 分发统计

### 跟踪下载

```bash
# 使用 GitHub API 获取下载统计
curl -s https://api.github.com/repos/yourusername/mykey/releases \
  | jq '.[] | {tag_name, download_count: (.assets | map(.download_count) | add)}'
```

### 使用分析工具

- [Plausible Analytics](https://plausible.io) - 隐私友好的分析
- [Fathom Analytics](https://usefathom.com) - 简单的分析
- [GoAccess](https://goaccess.io) - 服务器日志分析

## 🔐 代码签名和公证

### 对分发的应用进行签名

```bash
# 1. 获取签名身份
security find-identity -v -p codesigning

# 2. 签名应用
codesign -s "Developer ID Application: Your Name (TEAM_ID)" \
  --options runtime \
  --entitlements entitlements.plist \
  src-tauri/target/release/bundle/macos/MyKey.app

# 3. 验证签名
codesign -v src-tauri/target/release/bundle/macos/MyKey.app
```

### 公证应用

```bash
# 1. 创建应用专用密码
# https://appleid.apple.com/account/security

# 2. 保存凭证
xcrun notarytool store-credentials "MyKey" \
  --apple-id "your-email@example.com" \
  --team-id "TEAM_ID" \
  --password "app-specific-password"

# 3. 公证 DMG
xcrun notarytool submit src-tauri/target/release/bundle/dmg/MyKey_*.dmg \
  --keychain-profile "MyKey" \
  --wait

# 4. Staple 凭证
xcrun stapler staple src-tauri/target/release/bundle/macos/MyKey.app
```

## 📢 推广

### 发布公告

1. **GitHub Discussions**
   - 在项目中创建 Discussion
   - 宣布新版本

2. **社交媒体**
   - Twitter: 发布发布公告
   - Reddit: 在相关 subreddit 中发布
   - Product Hunt: 提交应用

3. **开发者社区**
   - Hacker News
   - Dev.to
   - Medium

4. **邮件列表**
   - 如果有用户邮件列表，发送通知

### 发布公告模板

```markdown
🎉 MyKey v1.0.0 发布！

MyKey 是一个本地优先的 AI 资产管理工具，帮助开发者安全地管理 API 密钥。

✨ 核心特性：
- 🔐 本地加密存储
- 📊 可视化管理
- 📁 智能导入
- 🔑 多提供商支持

📥 下载: https://github.com/yourusername/mykey/releases/v1.0.0

#MyKey #OpenSource #MacOS #Developer
```

## 📈 版本管理

### 语义化版本

遵循 [Semantic Versioning](https://semver.org/):
- **主版本**: 不兼容的 API 变更
- **次版本**: 向后兼容的新功能
- **修订版本**: 向后兼容的 bug 修复

示例: `v1.0.0`, `v1.1.0`, `v1.1.1`

### 变更日志

```markdown
# 变更日志

## [1.0.0] - 2024-02-10

### 新增
- 初始版本发布
- 密钥管理功能
- 智能导入功能

### 修复
- 无

### 已知问题
- 无
```

## 🆘 用户支持

### 创建支持渠道

1. **GitHub Issues** - bug 报告
2. **GitHub Discussions** - 问题讨论
3. **Email** - 直接支持
4. **Discord** - 社区支持

### 常见问题 (FAQ)

创建 FAQ 页面回答常见问题。

---

祝您成功分发 MyKey！🚀
