#!/bin/bash

# MyKey macOS Build Script
# 这个脚本将自动为 macOS 构建 MyKey 应用

set -e

echo "🔨 MyKey macOS 构建脚本"
echo "========================"
echo ""

# 检查前置条件
echo "📋 检查前置条件..."

if ! command -v rustc &> /dev/null; then
    echo "❌ 错误: Rust 未安装"
    echo "请运行: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo "❌ 错误: Node.js 未安装"
    echo "请访问: https://nodejs.org"
    exit 1
fi

if ! command -v xcode-select &> /dev/null; then
    echo "❌ 错误: Xcode Command Line Tools 未安装"
    echo "请运行: xcode-select --install"
    exit 1
fi

echo "✅ 所有前置条件已满足"
echo ""

# 获取系统架构
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    echo "🎯 检测到 Apple Silicon (M1/M2/M3)"
    TARGET="aarch64-apple-darwin"
elif [ "$ARCH" = "x86_64" ]; then
    echo "🎯 检测到 Intel Mac"
    TARGET="x86_64-apple-darwin"
else
    echo "⚠️  未知架构: $ARCH"
    TARGET="universal-apple-darwin"
fi

echo ""
echo "📦 安装依赖..."
npm install

echo ""
echo "🔨 构建前端..."
npm run build

echo ""
echo "🚀 构建 macOS 应用..."
echo "这可能需要几分钟，请耐心等待..."
npm run tauri:build

echo ""
echo "✅ 构建完成！"
echo ""
echo "📍 应用位置:"
echo "   $PWD/src-tauri/target/release/bundle/macos/MyKey.app"
echo ""
echo "🚀 运行应用:"
echo "   open $PWD/src-tauri/target/release/bundle/macos/MyKey.app"
echo ""
echo "📦 DMG 安装程序:"
ls -lh src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || echo "   (未生成 DMG)"
echo ""
echo "祝您使用愉快！🎉"
