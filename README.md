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



可以启动，但不完整：
最后一条命令是前台运行，SSH 断开后可能停止。
standalone 默认不会复制 public 和 .next/static。本项目的 NC 解析 Worker 位于 public，不复制会导致文件加载失败。Next.js 官方说明
推荐使用 PM2：
# 进入项目目录
cd /opt/NCRenderer

# 安装并构建
npm ci
npm run build

# 补齐 standalone 静态资源
cp -r public .next/standalone/
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/

# 安装 PM2
sudo npm install -g pm2

# 后台启动
cd .next/standalone
PORT=3000 HOSTNAME=0.0.0.0 pm2 start server.js --name nc-renderer

# 保存进程列表
pm2 save

# 设置服务器重启后自动运行
pm2 startup
pm2 startup 会输出一条带 sudo 的命令，还需要复制执行那条命令，然后再次运行：
pm2 save
常用管理命令：
pm2 status
pm2 logs nc-renderer
pm2 restart nc-renderer
pm2 stop nc-renderer
pm2 delete nc-renderer
更新部署：
cd /opt/NCRenderer
git pull
npm ci
npm run build

cp -r public .next/standalone/
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/

pm2 restart nc-renderer --update-env
如果前面配置 Nginx，建议服务只监听本机：
PORT=3000 HOSTNAME=127.0.0.1 pm2 start server.js --name nc-renderer
如果没有 Nginx、需要直接通过服务器 IP 访问，才使用：
HOSTNAME=0.0.0.0
并在防火墙或云服务器安全组中开放 TCP 3000 端口。


服务器的 Node.js 18 太旧。建议升级到 Node.js 22 LTS；Node 22 当前仍是受支持的 LTS 版本。Node.js 官方下载
使用 NVM 升级：
# 安装 NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash

# 当前终端立即加载 NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# 安装并切换 Node.js 22
nvm install 22
nvm use 22
nvm alias default 22

# 确认版本
node -v
npm -v
node -v 应显示 v22.x.x。
然后删除 Node 18 安装的旧依赖并重新构建：
cd /opt/NCRenderer

rm -rf node_modules .next
npm ci
npm run build
确认 server.js：
ls -la .next/standalone/server.js
复制静态资源：
cp -r public .next/standalone/
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/
切换 Node 版本后，PM2 也建议重新安装：
npm install -g pm2
pm2 kill
最后后台启动：
PORT=3000 HOSTNAME=0.0.0.0 \
pm2 start .next/standalone/server.js --name nc-renderer

pm2 save
pm2 startup
执行 pm2 startup 输出的那条 sudo 命令，然后再运行：
pm2 save
pm2 status
pm2 logs nc-renderer
不要再使用 Node.js 18 构建，否则 Next.js 会继续直接拒绝启动。