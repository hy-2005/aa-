/**
 * 生成 Windows 多尺寸 .ico 文件（基于向日葵.png）。
 * electron-builder 在 Windows 打包时需要包含 16/32/48/256 等多种尺寸。
 */
const fs = require("fs");
const path = require("path");
const pngToIco = require("png-to-ico").default;
const sharp = require("sharp");

const SOURCE_PNG = path.resolve(__dirname, "../assests/icons/向日葵.png");
// electron-builder 会读取这里；NSIS 安装包图标、桌面快捷方式、任务栏都来自这个文件
const TARGET_ICO = path.resolve(__dirname, "../assests/icons/app-icon.ico");

// png-to-ico 默认会把图片缩放到 256/48/32/16 四个标准尺寸，这正好覆盖 Windows 所有场景
// （开始菜单、任务栏、资源管理器、桌面快捷方式）。
const SIZES = [16, 32, 48, 256];
const TMP_DIR = path.resolve(__dirname, "../.tmp-icon-build");

async function main() {
  if (!fs.existsSync(SOURCE_PNG)) {
    console.error(`找不到源文件: ${SOURCE_PNG}`);
    process.exit(1);
  }

  // 1. 先把源 PNG 缩放成正方形临时 PNG（png-to-ico 要求源图是正方形）
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tempFiles = [];
  for (const size of SIZES) {
    const outPath = path.join(TMP_DIR, `icon-${size}.png`);
    await sharp(SOURCE_PNG)
      .resize(size, size, { fit: "cover" })
      .png()
      .toFile(outPath);
    tempFiles.push(outPath);
    console.log(`已生成 ${size}x${size} PNG -> ${outPath}`);
  }

  // 2. 把这些 PNG 合并成单个 .ico
  const icoBuffer = await pngToIco(tempFiles);
  fs.writeFileSync(TARGET_ICO, icoBuffer);
  console.log(`\n✅ 已写入: ${TARGET_ICO} (${icoBuffer.length} bytes)`);

  // 3. 清理临时目录
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("生成失败:", err);
  process.exit(1);
});