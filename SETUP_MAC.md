# MyKey macOS 设置指南

## 📦 安装方式

### 方式 1: 使用 DMG 安装程序 (最简单)

1. 下载 `MyKey_*.dmg` 文件
2. 双击打开 DMG 文件
3. 将 MyKey 应用拖到 Applications 文件夹
4. 打开 Applications 文件夹，双击 MyKey 启动

### 方式 2: 直接运行应用

1. 下载 `MyKey.app` 文件夹
2. 将其放在 Applications 文件夹中
3. 打开 Applications，双击 MyKey 启动

### 方式 3: 从源代码构建

参考 [BUILD_MAC.md](./BUILD_MAC.md)

## 🔒 首次启动

### 第一步: 设置主密码

1. 启动 MyKey 应用
2. 您会看到一个登录界面
3. 输入一个**强密码**作为主密码
   - 建议至少 12 个字符
   - 包含大小写字母、数字和符号
   - 例如: `MyKey@2024!Secure`
4. 点击 "设置密码"

⚠️ **重要**: 请妥善保管您的主密码。如果忘记，将无法恢复您的密钥。

### 第二步: 添加第一个密钥

#### 方式 A: 手动添加

1. 点击 "+ 添加密钥" 按钮
2. 选择提供商 (例如: OpenAI)
3. 输入密钥名称 (例如: My OpenAI Key)
4. 输入 API 密钥
5. 点击 "添加"

#### 方式 B: 从 .env 文件导入

1. 点击 "📁 导入" 按钮
2. 打开您的 `.env` 文件，复制内容
3. 粘贴到导入框中
4. 点击 "导入"

MyKey 会自动识别所有密钥并导入。

## 🔐 安全建议

### 1. 主密码安全

- ✅ 使用强密码（至少 12 个字符）
- ✅ 包含大小写字母、数字和符号
- ✅ 定期更换密码
- ❌ 不要使用生日、名字等容易猜测的信息
- ❌ 不要将密码写在便签上
- ❌ 不要与他人分享密码

### 2. 密钥管理

- ✅ 定期轮换 API 密钥
- ✅ 为不同的应用使用不同的密钥
- ✅ 监控异常的密钥使用
- ❌ 不要在代码中硬编码密钥
- ❌ 不要在版本控制中提交 `.env` 文件

### 3. 系统安全

- ✅ 保持 macOS 最新版本
- ✅ 启用 FileVault 磁盘加密
- ✅ 使用防火墙
- ✅ 定期备份数据
- ❌ 不要在公共 WiFi 上使用敏感密钥

## 🆘 常见问题

### Q: 应用无法启动

**解决方案**:

1. 检查 macOS 版本是否为 10.13 或更高
2. 尝试重新启动电脑
3. 从 Applications 文件夹中删除应用，重新安装
4. 检查是否有足够的磁盘空间

### Q: 提示 "无法打开应用，因为它来自身份不明的开发者"

**解决方案**:

1. 打开 System Preferences > Security & Privacy
2. 点击 "Open Anyway" 按钮
3. 或在终端中运行: `xattr -d com.apple.quarantine /Applications/MyKey.app`

### Q: 忘记了主密码

**解决方案**:

不幸的是，由于安全原因，无法恢复。您需要：

1. 卸载应用 (删除 MyKey.app)
2. 删除应用数据 (如果有)
3. 重新安装应用
4. 设置新的主密码

### Q: 密钥无法导入

**解决方案**:

1. 确保 `.env` 文件格式正确
2. 检查密钥格式是否符合要求
3. 尝试手动添加密钥
4. 查看应用日志获取更多信息

### Q: 应用运行缓慢

**解决方案**:

1. 关闭其他应用释放内存
2. 重启应用
3. 重启电脑
4. 检查磁盘空间是否充足

## 📱 使用技巧

### 快速搜索

虽然当前版本没有搜索框，但您可以：
- 按 Provider 分组查看密钥
- 点击密钥查看详细信息

### 批量导入

如果有多个 `.env` 文件：
1. 合并所有 `.env` 文件内容
2. 一次性导入所有密钥

### 密钥备份

虽然 MyKey 不提供自动备份，但您可以：
1. 定期导出密钥列表 (手动记录)
2. 在多台设备上设置 MyKey (各自独立)
3. 使用 Time Machine 备份整个 Mac

## 🔄 更新应用

### 检查更新

1. 打开 MyKey 应用
2. 点击菜单 > 检查更新 (如果有)
3. 按照提示更新

### 手动更新

1. 从 [GitHub Releases](https://github.com/yourusername/mykey/releases) 下载最新版本
2. 关闭当前应用
3. 将新的 MyKey.app 替换旧版本
4. 重新启动应用

## 🗑️ 卸载应用

### 完全卸载

```bash
# 删除应用
rm -rf /Applications/MyKey.app

# 删除应用数据 (可选)
rm -rf ~/Library/Application\ Support/com.mykey.app
rm -rf ~/Library/Caches/com.mykey.app
rm -rf ~/Library/Preferences/com.mykey.app
```

或使用应用卸载工具如 AppCleaner。

## 📞 获取帮助

- 📖 查看 [README.md](./README.md)
- 🐛 报告 Bug: [GitHub Issues](https://github.com/yourusername/mykey/issues)
- 💬 讨论: [GitHub Discussions](https://github.com/yourusername/mykey/discussions)
- 📧 邮件: support@mykey.app

---

祝您使用 MyKey 愉快！🔐✨
