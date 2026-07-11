# Pathforge — NC Renderer

一个使用 WebGL2 shader 实现的 NC / G-code 路径查看器。所有解析和渲染都在浏览器本地完成，文件不会上传。

## 已实现

- 自动计算包围盒并将任意坐标范围居中显示
- 左键旋转、右键/中键平移、滚轮缩放，支持 TOP / FRONT / ISO 视角
- GLSL shader 渲染路径与点，VBO 自动按 75 万点分块
- Web Worker 流式解析大文件，不阻塞界面
- 左侧点表使用虚拟滚动，百万行也只创建可见 DOM
- 点击列表行聚焦到点；画布使用 32 位离屏颜色编码进行 GPU 拾取并同步源文件行号
- 载入时用 Float64 计算中心和边界，再存为中心相对 Float32，兼顾大坐标精度和显存占用

## 运行

需要 Node.js 20.9 或更高版本：

```bash
npm install
npm run dev
```

浏览器打开终端中显示的本地地址。也可以直接拖放 `.nc`、`.tap`、`.gcode` 或 `.txt` 文件。

## 支持的坐标格式

解析器识别每行中的 `X`、`Y`、`Z`，支持整数、小数、科学计数法、可选等号和模态坐标，例如：

```nc
G0 X100 Y200 Z5
G1 X101.25 Y200.5
X=1.2e8 Y=-4.5 Z=0
```

未在当前行给出的轴会沿用上一点的数值。圆弧指令目前按 NC 文件中给出的端点连接；若需要 G2/G3 圆弧插补，可在解析 Worker 中扩展。

## 服务器部署

### Docker（推荐）

```bash
docker build -t pathforge-nc .
docker run -d --name pathforge-nc --restart unless-stopped -p 3000:3000 pathforge-nc
```

访问 `http://服务器IP:3000`。生产环境建议用 Nginx 或 Caddy 将域名反向代理到 `127.0.0.1:3000`，并配置 HTTPS。

### 直接部署 Node.js

服务器需要 Node.js 20.9 或更高版本：

```bash
npm ci
npm run build
PORT=3000 HOSTNAME=0.0.0.0 node .next/standalone/server.js
```

如果使用 PM2：

```bash
pm2 start .next/standalone/server.js --name pathforge-nc
pm2 save
```
