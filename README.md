# Idea Storm Lab

一个本地可运行的邀请制创业脑暴 Web App。

## 启动

```bash
cp .env.example .env
python3 app.py
```

打开：

```text
http://127.0.0.1:8768
```

## 下一步学习路径

- 本地继续开发：改 `skills/analysis_skill.md`，然后重新分析想法。
- 学习部署上线：看 [docs/deployment.md](docs/deployment.md)。
- 学习优化分析能力：看 [docs/skill-iteration.md](docs/skill-iteration.md)。
- 服务器配置模板在 [deploy/](deploy/)。

默认邀请码：

```text
BRAINSTORM-2026
```

## API Key

把你的 Key 写进 `.env`：

```text
OPENAI_API_KEY=你的 API Key
OPENAI_MODEL=qwen-plus
OPENAI_API_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
PORT=8768
```

Key 只会在本地后端读取，不会出现在浏览器页面里。没有配置 Key 或额度不足时，系统会使用本地示例分析，并在分析结果顶部提示原因。

## 分析 Skill

分析方法在这里维护：

```text
skills/analysis_skill.md
```

它定义了 LLM 的分析角色、分析流程、质量标准和输出字段。修改这个文件并重启服务后，新的想法分析会使用更新后的 Skill。

## 第一版能力

- 邀请码注册，不限制成员人数
- 每个成员都有独立身份
- 成员可以创建任意多个想法实例
- 所有人可查看所有想法，并能看到作者
- 只有作者可以编辑自己的想法和附件
- 支持图片、文档等附件上传
- 创建、编辑、上传或删除附件后自动更新分析
- 输出文字版分析和商业模式画布
