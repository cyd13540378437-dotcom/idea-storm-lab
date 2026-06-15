# 云服务器部署手册

这份文档的目标是：把本地运行的 Idea Storm Lab 部署到一台云服务器上，让你和朋友可以通过域名访问。

## 推荐第一阶段架构

先用最简单可靠的方式上线：

```text
浏览器
  -> 域名 + HTTPS
  -> Nginx
  -> Python 后端服务
  -> SQLite 数据库 + uploads 文件夹
  -> Qwen / DashScope API
```

第一阶段不急着上 PostgreSQL、对象存储、队列和容器。你们先真实用 1-2 周，确定产品流程和 Skill 质量，再升级架构。

## 你需要准备

- 一台云服务器，建议系统选择 Ubuntu 22.04 或 24.04。
- 一个域名，并把域名解析到服务器公网 IP。
- 服务器开放端口：
  - `22`：SSH 登录
  - `80`：HTTP
  - `443`：HTTPS
- Qwen / DashScope API Key。

## 服务器目录建议

建议把项目放在：

```text
/opt/idea-storm-lab
```

数据会在项目内：

```text
/opt/idea-storm-lab/data/brainstorm.db
/opt/idea-storm-lab/uploads/
```

## 1. 登录服务器

在你本地电脑终端执行：

```bash
ssh root@你的服务器IP
```

如果你使用普通用户，把 `root` 换成对应用户名。

## 2. 安装系统依赖

```bash
apt update
apt install -y python3 python3-venv nginx certbot python3-certbot-nginx rsync
```

## 3. 上传项目

在本地项目目录执行：

```bash
rsync -av \
  --exclude ".env" \
  --exclude "data/*.db" \
  --exclude "data/server*" \
  --exclude "uploads/*" \
  --exclude ".pycache" \
  ./ root@你的服务器IP:/opt/idea-storm-lab/
```

注意：不要把本地 `.env` 直接传到服务器。服务器上单独创建 `.env`。

## 4. 在服务器创建 `.env`

```bash
cd /opt/idea-storm-lab
cp .env.example .env
nano .env
```

服务器上建议这样配置：

```text
OPENAI_API_KEY=你的 DashScope Key
OPENAI_MODEL=qwen-plus
OPENAI_API_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
INVITE_CODE=换成一个你自己的初始邀请码
HOST=127.0.0.1
PORT=8768
MAX_UPLOAD_MB=25
```

保存后退出。

## 5. 先手动试跑

```bash
cd /opt/idea-storm-lab
python3 app.py
```

看到类似输出就说明服务启动了：

```text
Brainstorm Lab is running at http://127.0.0.1:8768
```

按 `Ctrl+C` 停掉，继续配置后台服务。

## 6. 配置 systemd 后台服务

复制模板：

```bash
cp /opt/idea-storm-lab/deploy/idea-storm-lab.service /etc/systemd/system/idea-storm-lab.service
```

如果你的项目路径不是 `/opt/idea-storm-lab`，需要编辑这个文件：

```bash
nano /etc/systemd/system/idea-storm-lab.service
```

启动服务：

```bash
systemctl daemon-reload
systemctl enable idea-storm-lab
systemctl start idea-storm-lab
systemctl status idea-storm-lab
```

查看日志：

```bash
journalctl -u idea-storm-lab -f
```

## 7. 配置 Nginx

复制模板：

```bash
cp /opt/idea-storm-lab/deploy/nginx-idea-storm-lab.conf /etc/nginx/sites-available/idea-storm-lab
```

编辑域名：

```bash
nano /etc/nginx/sites-available/idea-storm-lab
```

把：

```text
your-domain.com
```

换成你的真实域名。

启用站点：

```bash
ln -s /etc/nginx/sites-available/idea-storm-lab /etc/nginx/sites-enabled/idea-storm-lab
nginx -t
systemctl reload nginx
```

## 8. 配置 HTTPS

```bash
certbot --nginx -d your-domain.com
```

按提示选择自动跳转 HTTPS。

完成后访问：

```text
https://your-domain.com
```

## 9. 日常更新项目

本地改完代码后，再同步：

```bash
rsync -av \
  --exclude ".env" \
  --exclude "data/*.db" \
  --exclude "data/server*" \
  --exclude "uploads/*" \
  --exclude ".pycache" \
  ./ root@你的服务器IP:/opt/idea-storm-lab/
```

服务器上重启：

```bash
systemctl restart idea-storm-lab
```

## 10. 备份

至少每天备份：

```text
data/brainstorm.db
uploads/
skills/analysis_skill.md
.env
```

一个简单备份命令：

```bash
mkdir -p /opt/backups/idea-storm-lab
tar -czf /opt/backups/idea-storm-lab/backup-$(date +%F).tar.gz \
  /opt/idea-storm-lab/data/brainstorm.db \
  /opt/idea-storm-lab/uploads \
  /opt/idea-storm-lab/skills \
  /opt/idea-storm-lab/.env
```

## 11. 上线前安全检查

- `.env` 不能放进公开仓库。
- 初始邀请码要改掉，不要继续用默认值。
- API Key 建议使用专门为这个项目创建的 Key。
- 服务器只开放必要端口。
- Nginx 必须启用 HTTPS。
- 定期备份 SQLite 数据库和上传文件。
- 如果未来开放给更多人，需要增加文件类型限制、上传扫描和更严格的成员管理。

## 什么时候升级架构

继续用 SQLite 的条件：

- 只有几个人使用。
- 上传文件不多。
- 分析任务不密集。

考虑升级的信号：

- 成员超过 20 人。
- 文件上传量明显变大。
- 多人同时频繁提交想法。
- 需要更稳定的权限、审计和备份。

下一阶段可以升级为：

```text
PostgreSQL + 对象存储 + 后台任务队列 + 更正式的账号系统
```
