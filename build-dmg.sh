#!/bin/bash

# MyKey DMG Build Script
# 自动构建 macOS DMG 安装程序

set -e

echo "🔨 MyKey DMG 构建脚本"
echo "===================="
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_status() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# 检查前置条件
print_status "检查前置条件..."

if ! command -v rustc &> /dev/null; then
    print_error "Rust 未安装"
    echo "请运行: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

if ! command -v node &> /dev/null; then
    print_error "Node.js 未安装"
    echo "请访问: https://nodejs.org"
    exit 1
fi

if ! command -v xcode-select &> /dev/null; then
    print_error "Xcode Command Line Tools 未安装"
    echo "请运行: xcode-select --install"
    exit 1
fi

print_success "所有前置条件已满足"
echo ""

# 获取系统信息
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    print_status "检测到 Apple Silicon (M1/M2/M3)"
    ARCH_NAME="Apple Silicon"
elif [ "$ARCH" = "x86_64" ]; then
    print_status "检测到 Intel Mac"
    ARCH_NAME="Intel"
else
    print_warning "未知架构: $ARCH"
    ARCH_NAME="Unknown"
fi

echo ""

# 检查项目结构
print_status "检查项目结构..."

if [ ! -f "package.json" ]; then
    print_error "未找到 package.json，请在项目根目录运行此脚本"
    exit 1
fi

if [ ! -d "src-tauri" ]; then
    print_error "未找到 src-tauri 目录"
    exit 1
fi

print_success "项目结构正确"
echo ""

# 安装依赖
print_status "安装 npm 依赖..."
npm install --silent
print_success "npm 依赖已安装"
echo ""

# 构建前端
print_status "构建前端资源..."
npm run build
print_success "前端构建完成"
echo ""

# 清理旧的构建文件
print_status "清理旧的构建文件..."
rm -rf src-tauri/target/release/bundle/dmg
rm -rf src-tauri/target/release/bundle/macos
print_success "清理完成"
echo ""

# 构建 DMG
print_status "构建 DMG 安装程序..."
print_warning "这可能需要 5-15 分钟，请耐心等待..."
echo ""

if npm run tauri:build; then
    print_success "DMG 构建完成！"
else
    print_error "DMG 构建失败"
    exit 1
fi

echo ""
echo "===================="
echo "✅ 构建成功！"
echo "===================="
echo ""

# 查找生成的 DMG 文件
DMG_DIR="src-tauri/target/release/bundle/dmg"
APP_DIR="src-tauri/target/release/bundle/macos"

if [ -d "$DMG_DIR" ]; then
    print_status "生成的 DMG 文件:"
    ls -lh "$DMG_DIR"/*.dmg 2>/dev/null || print_warning "未找到 DMG 文件"
    echo ""
fi

if [ -d "$APP_DIR" ]; then
    print_status "生成的应用文件:"
    ls -lh "$APP_DIR"/MyKey.app 2>/dev/null || print_warning "未找到应用文件"
    echo ""
fi

# 提供后续步骤
echo "📋 后续步骤:"
echo ""
echo "1️⃣  测试应用:"
echo "   open $APP_DIR/MyKey.app"
echo ""
echo "2️⃣  测试 DMG 安装:"
echo "   hdiutil attach $DMG_DIR/MyKey_*.dmg"
echo "   # 在 Finder 中拖动应用到 Applications 文件夹"
echo "   hdiutil detach /Volumes/MyKey"
echo ""
echo "3️⃣  分发应用:"
echo "   # 上传到 GitHub Releases 或您的服务器"
echo "   # 可选: 进行代码签名和公证"
echo ""
echo "📖 更多信息请查看 DMG_BUILD_GUIDE.md"
echo ""
echo "祝您使用愉快！🎉"
