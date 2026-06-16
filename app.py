#!/usr/bin/env python3
import cgi
import hashlib
import json
import mimetypes
import os
import secrets
import shutil
import sqlite3
import string
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
UPLOAD_DIR = ROOT / "uploads"
DB_PATH = DATA_DIR / "brainstorm.db"
ANALYSIS_SKILL_PATH = ROOT / "skills" / "analysis_skill.md"
SESSION_DAYS = 14

CANVAS_KEYS = [
    "customer_segments",
    "value_propositions",
    "channels",
    "customer_relationships",
    "revenue_streams",
    "key_resources",
    "key_activities",
    "key_partners",
    "cost_structure",
]


def load_dotenv():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def now_iso():
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def max_upload_bytes():
    return int(os.getenv("MAX_UPLOAD_MB", "25")) * 1024 * 1024


def hash_passcode(passcode, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.sha256((salt + passcode).encode("utf-8")).hexdigest()
    return salt, digest


def random_code(length=10):
    alphabet = string.ascii_uppercase + string.digits
    return "-".join(
        "".join(secrets.choice(alphabet) for _ in range(5))
        for _ in range(max(1, length // 5))
    )


def safe_filename(name):
    base = Path(name or "upload").name
    cleaned = []
    for char in base:
        if char.isalnum() or char in "._- ":
            cleaned.append(char)
    value = "".join(cleaned).strip(" .")
    return value or "upload"


def connect_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def row_to_dict(row):
    return dict(row) if row else None


def init_db():
    DATA_DIR.mkdir(exist_ok=True)
    UPLOAD_DIR.mkdir(exist_ok=True)
    with connect_db() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                pass_salt TEXT NOT NULL,
                pass_hash TEXT NOT NULL,
                avatar_color TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS invites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                uses INTEGER NOT NULL DEFAULT 0,
                max_uses INTEGER,
                created_at TEXT NOT NULL,
                expires_at TEXT
            );

            CREATE TABLE IF NOT EXISTS ideas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                content_version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attachments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
                filename TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                content_type TEXT,
                size INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS analyses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                source TEXT NOT NULL,
                content_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS clarification_answers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
                question_id TEXT NOT NULL,
                question_label TEXT,
                question_text TEXT NOT NULL,
                answer TEXT NOT NULL,
                is_fallback INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (idea_id, question_id)
            );
            """
        )
        seed_code = os.getenv("INVITE_CODE", "BRAINSTORM-2026").strip()
        if seed_code:
            conn.execute(
                """
                INSERT OR IGNORE INTO invites (code, created_by, uses, max_uses, created_at)
                VALUES (?, NULL, 0, NULL, ?)
                """,
                (seed_code, now_iso()),
            )


def get_latest_analysis(conn, idea_id):
    row = conn.execute(
        """
        SELECT * FROM analyses
        WHERE idea_id = ?
        ORDER BY version DESC, id DESC
        LIMIT 1
        """,
        (idea_id,),
    ).fetchone()
    if not row:
        return None
    data = row_to_dict(row)
    try:
        data["content"] = json.loads(data.pop("content_json"))
    except json.JSONDecodeError:
        data["content"] = build_empty_analysis()
    return data


def list_attachments(conn, idea_id):
    return [
        row_to_dict(row)
        for row in conn.execute(
            "SELECT * FROM attachments WHERE idea_id = ? ORDER BY id ASC", (idea_id,)
        ).fetchall()
    ]


def list_clarification_answers(conn, idea_id):
    return [
        row_to_dict(row)
        for row in conn.execute(
            """
            SELECT question_id, question_label, question_text, answer, is_fallback, created_at, updated_at
            FROM clarification_answers
            WHERE idea_id = ?
            ORDER BY id ASC
            """,
            (idea_id,),
        ).fetchall()
    ]


def public_user(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "avatar_color": row["avatar_color"],
        "created_at": row["created_at"],
    }


def public_idea(conn, row, viewer_id=None, include_detail=False):
    author = conn.execute("SELECT * FROM users WHERE id = ?", (row["author_id"],)).fetchone()
    attachments = list_attachments(conn, row["id"])
    clarification_answers = list_clarification_answers(conn, row["id"])
    latest = get_latest_analysis(conn, row["id"])
    summary = ""
    if latest:
        summary = latest["content"].get("content_extract", {}).get("summary", "")
    idea = {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"] if include_detail else "",
        "content_version": row["content_version"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "author": public_user(author),
        "attachments": attachments,
        "attachment_count": len(attachments),
        "clarification_answers": clarification_answers,
        "analysis": latest,
        "summary": summary,
        "can_edit": viewer_id == row["author_id"],
    }
    return idea


def build_empty_analysis():
    return {
        "content_extract": {"summary": "", "key_points": []},
        "competitors": [],
        "user_segments": [],
        "business_flow": [],
        "operation_model": [],
        "hook_analysis": {"summary": "", "hooks": []},
        "capital_story": "",
        "product_capabilities": [],
        "tech_stack": [],
        "risks": [],
        "assumptions": [],
        "missing_info": [],
        "clarifying_questions": [],
        "section_scores": {},
        "synthesis_changes": [],
        "canvas": {key: [] for key in CANVAS_KEYS},
    }


def load_analysis_skill():
    if ANALYSIS_SKILL_PATH.exists():
        return ANALYSIS_SKILL_PATH.read_text(encoding="utf-8").strip()
    return (
        "你是一个创业产品策划与投融资分析助手。请基于用户提交的想法，"
        "输出具体、可执行、保持中文的结构化分析。"
    )


def split_key_points(text):
    normalized = text.replace("\r", "\n")
    pieces = []
    for line in normalized.split("\n"):
        line = line.strip(" -\t")
        if len(line) >= 6:
            pieces.append(line)
    if not pieces:
        sentences = [part.strip() for part in normalized.replace("。", "。\n").split("\n")]
        pieces = [part for part in sentences if len(part) >= 6]
    return pieces[:5]


def read_text_snippet(path, filename, content_type):
    suffix = Path(filename).suffix.lower()
    try:
        if suffix in {".txt", ".md", ".csv", ".json", ".xml", ".html", ".css", ".js"} or (
            content_type or ""
        ).startswith("text/"):
            return path.read_text(encoding="utf-8", errors="ignore")[:5000]
        if suffix == ".docx":
            with zipfile.ZipFile(path) as docx:
                xml = docx.read("word/document.xml")
            root = ElementTree.fromstring(xml)
            texts = []
            for node in root.iter():
                if node.tag.endswith("}t") and node.text:
                    texts.append(node.text)
            return "\n".join(texts)[:5000]
    except Exception:
        return ""
    return ""


def idea_material(conn, idea):
    attachments = list_attachments(conn, idea["id"])
    answers = list_clarification_answers(conn, idea["id"])
    latest_analysis = get_latest_analysis(conn, idea["id"])
    latest_content = latest_analysis.get("content") if latest_analysis else {}
    attachment_lines = []
    snippets = []
    for item in attachments:
        attachment_lines.append(
            f"- {item['filename']} ({item.get('content_type') or 'unknown'}, {item['size']} bytes)"
        )
        path = UPLOAD_DIR / item["stored_name"]
        snippet = read_text_snippet(path, item["filename"], item.get("content_type"))
        if snippet:
            snippets.append(f"附件《{item['filename']}》可读取文本：\n{snippet}")
    previous_lines = []
    if isinstance(latest_content, dict):
        extract = latest_content.get("content_extract") or {}
        if extract.get("summary"):
            previous_lines.append(f"- 内容摘要：{extract.get('summary')}")
        for key, label in [
            ("user_segments", "核心用户"),
            ("operation_model", "运营模式"),
            ("hook_analysis", "抓手分析"),
            ("product_capabilities", "产品能力"),
            ("risks", "风险判断"),
            ("assumptions", "当前假设"),
            ("missing_info", "待补充信息"),
        ]:
            value = latest_content.get(key)
            if key == "hook_analysis" and isinstance(value, dict):
                hooks = value.get("hooks") if isinstance(value.get("hooks"), list) else []
                text = "；".join([str(item) for item in hooks[:3] if item])
                if value.get("summary"):
                    text = f"{value.get('summary')}；{text}" if text else str(value.get("summary"))
            elif isinstance(value, list):
                text = "；".join([str(item) for item in value[:3] if item])
            else:
                text = str(value or "").strip()
            if text:
                previous_lines.append(f"- {label}：{text}")
    return "\n".join(
        [
            f"标题：{idea['title']}",
            f"正文：\n{idea['body']}",
            "附件：",
            "\n".join(attachment_lines) if attachment_lines else "- 无",
            "\n\n".join(snippets),
            "已确认的澄清回答：",
            "\n".join(
                [
                    f"- {item['question_label'] or item['question_id']}：{item['question_text']}\n  回答：{item['answer']}"
                    + ("（用户选择了“我还没想好”，这是系统暂定推荐答案）" if item.get("is_fallback") else "")
                    for item in answers
                ]
            )
            if answers
            else "- 暂无",
            "已有分析摘要：",
            "\n".join(previous_lines) if previous_lines else "- 暂无",
            "本次分析要求：",
            "如果存在已确认的澄清回答，请基于这些回答和已有分析摘要继续修订分析；不要简单重复旧分析，要明确吸收新答案带来的判断变化。",
        ]
    )


def build_mock_analysis(idea, material, source="local"):
    body = idea["body"].strip()
    summary_seed = body or idea["title"]
    summary = summary_seed[:180] + ("..." if len(summary_seed) > 180 else "")
    key_points = split_key_points(body)
    if not key_points:
        key_points = [idea["title"], "需要进一步访谈目标用户，验证真实痛点和付费意愿。"]
    title = idea["title"]
    return {
        "content_extract": {
            "summary": summary or "这是一个待展开的早期想法，需要补充目标用户、场景和验证方式。",
            "key_points": key_points,
        },
        "competitors": [
            {
                "name": "待调研竞品",
                "reason": "当前信息不足以确认直接竞品，建议围绕目标用户正在使用的替代方案做访谈。",
            }
        ],
        "user_segments": [
            "创业早期团队，需要快速沉淀和比较想法的人",
            "远程协作的小团队，需要把零散灵感转成结构化判断的人",
        ],
        "business_flow": [
            "成员通过邀请码进入空间",
            "提交文字、图片或文档形式的想法",
            "系统生成结构化分析和商业模式画布",
            "团队查看、讨论并决定是否继续验证",
        ],
        "operation_model": [
            "早期以小团队订阅或按空间收费为主",
            "通过模板、分析深度和协作权限形成付费分层",
            "用创业社区、孵化器和独立开发者圈层做种子增长",
        ],
        "hook_analysis": {
            "summary": "当前最适合的抓手是把想法包装成一个能立刻降低讨论成本的小场景，而不是先讲完整平台故事。",
            "hooks": [
                "用一次真实团队脑暴前后的对比，证明 AI 能把模糊灵感变成可讨论对象",
                "从“下一步该问什么”切入，让用户感到系统不是写报告，而是在主持讨论",
                "把“我还没想好”也沉淀为待验证假设，降低早期表达压力",
            ],
        },
        "capital_story": f"“{title}”可以被包装成一个帮助创业团队降低早期决策成本的协作基础设施。它把创意输入、AI 分析和团队共识沉淀到同一个空间里，若能证明高频使用和跨团队扩张，就具备从工具切入工作流的增长故事。",
        "product_capabilities": [
            "邀请制身份与权限管理",
            "多模态想法采集和附件归档",
            "LLM 结构化分析与版本更新",
            "商业模式画布自动生成",
            "团队只读共享与作者编辑边界",
        ],
        "tech_stack": [
            "第一版：Python 本地服务、SQLite 数据库、本地文件存储",
            "上线版：后端 API 服务、PostgreSQL、对象存储、队列化 AI 分析任务",
            "LLM：通过服务端读取 API Key 调用模型，避免在浏览器暴露密钥",
        ],
        "risks": [
            "AI 分析可能看似完整但缺少真实用户证据",
            "附件里的图片和复杂文档需要后续增强内容解析",
            "协作工具若没有明确决策流程，容易变成灵感仓库",
        ],
        "assumptions": [
            "目标用户是否有足够高频和高痛感的使用场景仍需验证",
            "团队是否愿意围绕 AI 生成的分析形成稳定讨论流程仍需验证",
        ],
        "missing_info": [
            "最先愿意使用并付费的人群还不够具体",
            "用户当前替代方案和放弃替代方案的理由还不清楚",
            "第一版成功的验证指标还需要定义",
        ],
        "clarifying_questions": [
            {
                "id": "target_user",
                "type": "target_user",
                "label": "目标用户",
                "priority": 1,
                "question": "最先会强烈需要这个想法的人是谁？请尽量具体到角色、场景或当前困扰。",
                "why_it_matters": "用户不清楚时，后续价值主张、渠道和付费判断都会变虚。",
                "answer_type": "choice",
                "options": [
                    {
                        "id": "small_team_pm",
                        "label": "早期团队推进者",
                        "answer": "3-8 人早期创业团队里负责推进产品和讨论收敛的人。",
                        "reason": "他们最容易感受到想法分散和讨论无靶心的问题。",
                    },
                    {
                        "id": "incubator_mentor",
                        "label": "孵化器项目组",
                        "answer": "孵化器或训练营里的项目组，需要把想法快速转成路演和验证材料。",
                        "reason": "他们有明确评审节奏，愿意使用结构化工具提高准备效率。",
                    },
                ],
                "recommended_answer": "3-8 人早期创业团队里负责推进产品和讨论收敛的人。",
                "placeholder": "选择“其他答案”后，可以写你自己的目标用户。",
                "fallback_answer": "我还没想好",
                "fallback_effect": "系统会先采用推荐目标用户，并在分析中标记为待验证。",
            },
            {
                "id": "current_alternative",
                "type": "alternative",
                "label": "现有替代方案",
                "priority": 2,
                "question": "在没有这个产品之前，用户现在通常怎么解决这个问题？",
                "why_it_matters": "替代方案决定了产品真正要替换的行为，而不只是同类竞品。",
                "answer_type": "choice",
                "options": [
                    {
                        "id": "wechat_docs",
                        "label": "微信 + 文档",
                        "answer": "用户现在主要靠微信群聊天、飞书文档和人工整理来沉淀想法。",
                        "reason": "这是最常见的低成本替代方式，也最容易暴露信息散乱问题。",
                    },
                    {
                        "id": "mentor_chat",
                        "label": "找人聊",
                        "answer": "用户现在通常找朋友、导师或同事讨论，靠外部反馈帮助自己梳理。",
                        "reason": "说明产品需要替代一部分高质量对话，而不只是写文档。",
                    },
                ],
                "recommended_answer": "用户现在主要靠微信群聊天、飞书文档和人工整理来沉淀想法。",
                "placeholder": "选择“其他答案”后，可以写下真实替代方案。",
                "fallback_answer": "我还没想好",
                "fallback_effect": "系统会先采用最常见替代方案，并标记为待访谈验证。",
            },
            {
                "id": "validation_signal",
                "type": "validation",
                "label": "验证信号",
                "priority": 3,
                "question": "如果只用 7 天验证一次，你最想看到哪个信号来证明它值得继续做？",
                "why_it_matters": "早期想法需要尽快找到可验证的推进标准。",
                "answer_type": "choice",
                "options": [
                    {
                        "id": "weekly_use",
                        "label": "每周复用",
                        "answer": "至少 3 个团队愿意连续两周用它整理新想法。",
                        "reason": "复用能证明它不是一次性新鲜感，而是进入了讨论流程。",
                    },
                    {
                        "id": "pay_once",
                        "label": "为分析付费",
                        "answer": "至少 3 个团队愿意为一次高质量分析或工作坊付费。",
                        "reason": "付费信号能更直接验证问题强度和价值感。",
                    },
                ],
                "recommended_answer": "至少 3 个团队愿意连续两周用它整理新想法。",
                "placeholder": "选择“其他答案”后，可以写你自己的验证标准。",
                "fallback_answer": "我还没想好",
                "fallback_effect": "系统会先采用每周复用作为推荐验证信号。",
            },
        ],
        "section_scores": {
            "competitors": {
                "score": 62,
                "dimensions": [
                    {"label": "替代强度", "score": 70, "reason": "已有低成本替代行为存在"},
                    {"label": "差异空间", "score": 58, "reason": "需要证明 AI 主持比文档更有效"},
                    {"label": "调研清晰度", "score": 58, "reason": "还需要访谈真实替代路径"},
                ],
            },
            "user_segments": {
                "score": 68,
                "dimensions": [
                    {"label": "购买力", "score": 64, "reason": "早期团队预算有限但有明确效率诉求"},
                    {"label": "时间精力", "score": 78, "reason": "讨论和整理成本真实存在"},
                    {"label": "人群基数", "score": 62, "reason": "种子人群明确，但规模要继续验证"},
                ],
            },
            "hook_analysis": {
                "score": 72,
                "dimensions": [
                    {"label": "触发频率", "score": 70, "reason": "团队会反复产生和讨论想法"},
                    {"label": "情绪强度", "score": 68, "reason": "混乱和无法收敛会带来明显挫败感"},
                    {"label": "低成本验证", "score": 78, "reason": "可以用少量团队快速验证"},
                ],
            },
            "risks": {
                "score": 61,
                "dimensions": [
                    {"label": "风险识别度", "score": 70, "reason": "已识别 AI 幻觉和流程弱的问题"},
                    {"label": "验证动作清晰度", "score": 58, "reason": "还需要定义具体指标"},
                    {"label": "失败成本", "score": 55, "reason": "若无法进入讨论流程，留存风险较高"},
                ],
            },
        },
        "synthesis_changes": [],
        "canvas": {
            "customer_segments": ["远程创业小团队", "孵化器项目组", "独立开发者搭子"],
            "value_propositions": ["把零散想法快速变成可讨论的结构化方案", "降低早期创业团队的信息整理成本"],
            "channels": ["创业社区", "朋友邀请", "孵化器合作", "内容案例传播"],
            "customer_relationships": ["团队空间沉淀", "分析模板持续迭代", "围绕想法讨论形成复访"],
            "revenue_streams": ["团队订阅", "高级分析额度", "私有部署或顾问版"],
            "key_resources": ["LLM 分析能力", "想法与分析数据", "协作权限系统"],
            "key_activities": ["采集想法", "生成分析", "支持团队评审", "沉淀商业画布"],
            "key_partners": ["LLM 服务商", "云存储服务", "创业社区与孵化器"],
            "cost_structure": ["模型调用成本", "文件存储成本", "产品研发与运维", "获客成本"],
        },
        "_source": source,
        "_material_preview": material[:500],
    }


def strip_json_fence(text):
    value = text.strip()
    if value.startswith("```"):
        value = value.strip("`")
        if value.lower().startswith("json"):
            value = value[4:]
    return value.strip()


def extract_response_text(payload):
    if isinstance(payload, dict) and payload.get("output_text"):
        return payload["output_text"]
    choices = payload.get("choices", []) if isinstance(payload, dict) else []
    if choices:
        message = choices[0].get("message", {})
        content = message.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            texts = []
            for item in content:
                if isinstance(item, dict) and item.get("text"):
                    texts.append(item["text"])
            return "\n".join(texts)
    texts = []
    for item in payload.get("output", []) if isinstance(payload, dict) else []:
        if item.get("type") == "message":
            for content in item.get("content", []):
                if content.get("type") in {"output_text", "text"} and content.get("text"):
                    texts.append(content["text"])
                elif content.get("text"):
                    texts.append(content["text"])
    return "\n".join(texts)


def normalize_list(value):
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [item for item in value if item]
    return []


def normalize_hook_analysis(value):
    if isinstance(value, str):
        return {"summary": value, "hooks": []}
    if not isinstance(value, dict):
        return {"summary": "", "hooks": []}
    hooks = value.get("hooks", [])
    if isinstance(hooks, str):
        hooks = [hooks]
    if not isinstance(hooks, list):
        hooks = []
    return {
        "summary": str(value.get("summary") or "").strip(),
        "hooks": [item for item in hooks if item],
    }


def normalize_question_options(value):
    options = []
    raw_options = value if isinstance(value, list) else []
    for index, item in enumerate(raw_options[:4]):
        if isinstance(item, str):
            item = {"label": item, "answer": item}
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or item.get("title") or item.get("answer") or "").strip()
        answer = str(item.get("answer") or item.get("value") or label).strip()
        if not label or not answer:
            continue
        option_id = str(item.get("id") or f"option_{index + 1}").strip()
        option_id = "".join(
            char if char.isalnum() or char in "_-" else "_"
            for char in option_id.lower()
        ).strip("_") or f"option_{index + 1}"
        options.append(
            {
                "id": option_id,
                "label": label,
                "answer": answer,
                "reason": str(item.get("reason") or item.get("why") or "").strip(),
            }
        )
    return options


def normalize_clarifying_questions(value):
    questions = []
    raw_questions = value if isinstance(value, list) else []
    for index, item in enumerate(raw_questions[:2]):
        if isinstance(item, str):
            item = {"question": item}
        if not isinstance(item, dict):
            continue
        question = str(item.get("question") or "").strip()
        if not question:
            continue
        question_id = str(item.get("id") or item.get("type") or f"question_{index + 1}").strip()
        question_id = "".join(
            char if char.isalnum() or char in "_-" else "_"
            for char in question_id.lower()
        ).strip("_") or f"question_{index + 1}"
        options = normalize_question_options(item.get("options"))
        fallback_answer = "我还没想好"
        recommended_answer = str(item.get("recommended_answer") or "").strip()
        if not recommended_answer and options:
            recommended_answer = options[0]["answer"]
        questions.append(
            {
                "id": question_id,
                "type": str(item.get("type") or question_id).strip() or question_id,
                "label": str(item.get("label") or item.get("type") or f"问题 {index + 1}").strip(),
                "priority": item.get("priority") if isinstance(item.get("priority"), int) else index + 1,
                "question": question,
                "why_it_matters": str(item.get("why_it_matters") or item.get("reason") or "").strip(),
                "answer_type": "choice",
                "options": options,
                "recommended_answer": recommended_answer,
                "placeholder": str(item.get("placeholder") or "选择“其他答案”后，可以写你自己的判断。").strip(),
                "fallback_answer": fallback_answer,
                "fallback_effect": str(
                    item.get("fallback_effect") or "系统会先采用推荐答案，并在分析中标记为待验证。"
                ).strip(),
            }
        )
    questions.sort(key=lambda item: item["priority"])
    return questions


def clamp_score(value):
    try:
        if isinstance(value, str):
            digits = "".join(char for char in value if char.isdigit())
            value = digits or 0
        return max(0, min(100, int(value or 0)))
    except (TypeError, ValueError):
        return 0


def normalize_section_scores(value):
    if not isinstance(value, dict):
        return {}
    normalized = {}
    for key, raw in value.items():
        if not isinstance(raw, dict):
            continue
        dimensions = []
        raw_dimensions = raw.get("dimensions", [])
        if isinstance(raw_dimensions, list):
            for item in raw_dimensions[:5]:
                if not isinstance(item, dict):
                    continue
                dimensions.append(
                    {
                        "label": str(item.get("label") or item.get("name") or "评分维度").strip(),
                        "score": clamp_score(item.get("score")),
                        "reason": str(item.get("reason") or "").strip(),
                    }
                )
        normalized[str(key)] = {
            "score": clamp_score(raw.get("score")),
            "dimensions": dimensions,
        }
    return normalized


def normalize_analysis(data):
    empty = build_empty_analysis()
    if not isinstance(data, dict):
        return empty
    for key, value in empty.items():
        data.setdefault(key, value)
    for key in [
        "user_segments",
        "business_flow",
        "operation_model",
        "hook_analysis",
        "product_capabilities",
        "tech_stack",
        "risks",
        "assumptions",
        "missing_info",
        "synthesis_changes",
    ]:
        if key == "hook_analysis":
            data[key] = normalize_hook_analysis(data.get(key))
        else:
            data[key] = normalize_list(data.get(key))
    data["clarifying_questions"] = normalize_clarifying_questions(
        data.get("clarifying_questions")
    )
    data["section_scores"] = normalize_section_scores(data.get("section_scores"))
    canvas = data.get("canvas")
    if not isinstance(canvas, dict):
        canvas = {}
    for key in CANVAS_KEYS:
        value = canvas.get(key, [])
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            value = []
        canvas[key] = value
    data["canvas"] = canvas
    return data


def build_analysis_prompt():
    schema_hint = {
        "content_extract": {"summary": "string", "key_points": ["string"]},
        "competitors": [{"name": "string", "reason": "string"}],
        "user_segments": ["string"],
        "business_flow": ["string"],
        "operation_model": ["string"],
        "hook_analysis": {"summary": "string", "hooks": ["string"]},
        "capital_story": "string",
        "product_capabilities": ["string"],
        "tech_stack": ["string"],
        "risks": ["string"],
        "assumptions": ["string"],
        "missing_info": ["string"],
        "clarifying_questions": [
            {
                "id": "string",
                "type": "string",
                "label": "string",
                "priority": 1,
                "question": "string",
                "why_it_matters": "string",
                "answer_type": "choice",
                "options": [
                    {
                        "id": "string",
                        "label": "string",
                        "answer": "string",
                        "reason": "string",
                    }
                ],
                "recommended_answer": "string",
                "placeholder": "string",
                "fallback_answer": "我还没想好",
                "fallback_effect": "string",
            }
        ],
        "section_scores": {
            "section_key": {
                "score": 0,
                "dimensions": [
                    {"label": "string", "score": 0, "reason": "string"}
                ],
            }
        },
        "synthesis_changes": ["string"],
        "canvas": {key: ["string"] for key in CANVAS_KEYS},
    }
    skill = load_analysis_skill()
    return "\n\n".join(
        [
            skill,
            "输出要求：只输出严格合法的 JSON，不要输出 Markdown，不要解释，不要使用代码块。",
            "如果材料中包含澄清回答，必须优先使用这些回答修正分析。",
            "如果澄清回答标注为系统暂定推荐答案，必须把它当作当前版本的假设性输入，同时在 assumptions 或 risks 中保留待验证提醒。",
            "clarifying_questions 按需输出，可以为空；只有补充回答会明显改变分析判断时才输出 1-2 个最关键问题。",
            "如果输出 clarifying_questions，每个问题必须是选择题，必须包含 2-3 个 options、recommended_answer、fallback_answer。",
            "fallback_answer 固定使用“我还没想好”。用户选择该项时，系统会采用 recommended_answer 作为暂定回答，所以 recommended_answer 必须具体、可用于后续分析。",
            "每个分析章节除 content_extract 外，都必须在 section_scores 中给出评分。评分要使用与该章节强相关的维度，不要用通用维度。",
            "为了提升交互速度，所有列表默认 2-3 项；clarifying_questions 默认 0-1 个，除非第 2 个确实关键；每个问题默认 2 个 options；section_scores 每章默认 2-3 个维度。",
            "JSON 结构必须匹配以下字段，字段名不可更改：",
            json.dumps(schema_hint, ensure_ascii=False),
        ]
    )


def openai_request_config():
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return None, None, None, "未配置 OPENAI_API_KEY。"
    model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini").strip()
    api_url = os.getenv("OPENAI_API_URL", os.getenv("API_URL", "https://api.openai.com/v1")).strip()
    api_url = api_url.rstrip("/")
    return api_key, model, api_url, ""


def build_chat_body(model, material, stream=False):
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": build_analysis_prompt()},
            {"role": "user", "content": material[:18000]},
        ],
        "temperature": 0.2,
    }
    if stream:
        body["stream"] = True
    return body


def call_openai_analysis(idea, material):
    api_key, model, api_url, config_error = openai_request_config()
    if config_error:
        return None, config_error
    body = build_chat_body(model, material, stream=False)
    request = urllib.request.Request(
        f"{api_url}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
        text = strip_json_fence(extract_response_text(payload))
        parsed = json.loads(text)
        parsed["_source"] = f"llm:{model}"
        return normalize_analysis(parsed), ""
    except urllib.error.HTTPError as error:
        message = f"OpenAI 返回 HTTP {error.code}。"
        try:
            payload = json.loads(error.read().decode("utf-8", errors="replace"))
            detail = payload.get("error", {})
            if detail.get("message"):
                message = detail["message"]
        except Exception:
            pass
        return None, message
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError, ValueError) as error:
        return None, f"{type(error).__name__}: {error}"


def extract_stream_delta(payload):
    choices = payload.get("choices", []) if isinstance(payload, dict) else []
    if choices:
        delta = choices[0].get("delta", {})
        content = delta.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            texts = []
            for item in content:
                if isinstance(item, dict) and item.get("text"):
                    texts.append(item["text"])
            return "".join(texts)
    return ""


def call_openai_analysis_stream(idea, material, on_delta=None):
    api_key, model, api_url, config_error = openai_request_config()
    if config_error:
        return None, config_error
    body = build_chat_body(model, material, stream=True)
    request = urllib.request.Request(
        f"{api_url}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    chunks = []
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line or line.startswith(":") or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                payload = json.loads(data)
                delta = extract_stream_delta(payload)
                if delta:
                    chunks.append(delta)
                    if on_delta:
                        on_delta(delta)
        text = strip_json_fence("".join(chunks))
        parsed = json.loads(text)
        parsed["_source"] = f"llm:{model}"
        return normalize_analysis(parsed), ""
    except urllib.error.HTTPError as error:
        message = f"OpenAI 返回 HTTP {error.code}。"
        try:
            payload = json.loads(error.read().decode("utf-8", errors="replace"))
            detail = payload.get("error", {})
            if detail.get("message"):
                message = detail["message"]
        except Exception:
            pass
        return None, message
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError, ValueError) as error:
        return None, f"{type(error).__name__}: {error}"


def store_analysis(conn, idea_id, analysis, source):
    latest = conn.execute(
        "SELECT COALESCE(MAX(version), 0) AS version FROM analyses WHERE idea_id = ?",
        (idea_id,),
    ).fetchone()
    version = int(latest["version"]) + 1
    conn.execute(
        """
        INSERT INTO analyses (idea_id, version, source, content_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (idea_id, version, source, json.dumps(normalize_analysis(analysis), ensure_ascii=False), now_iso()),
    )
    return get_latest_analysis(conn, idea_id)


def analyze_and_store(conn, idea_id, source_reason="auto"):
    idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea_id,)).fetchone()
    if not idea:
        return None
    material = idea_material(conn, idea)
    analysis, fallback_reason = call_openai_analysis(idea, material)
    source = analysis.pop("_source", "openai") if analysis else "local"
    if not analysis:
        analysis = build_mock_analysis(idea, material, source=f"local:{source_reason}")
        analysis["_fallback_reason"] = fallback_reason or "真实 AI 分析未返回结果。"
        source = "local"
    return store_analysis(conn, idea_id, analysis, source)


def analysis_stream_sections(content):
    scores = content.get("section_scores", {}) if isinstance(content.get("section_scores"), dict) else {}
    sections = [
        {
            "key": "content_extract",
            "title": "内容提取",
            "summary": content.get("content_extract", {}).get("summary", ""),
            "items": content.get("content_extract", {}).get("key_points", []),
        },
        {"key": "competitors", "title": "竞品线索", "items": content.get("competitors", [])},
        {"key": "user_segments", "title": "核心用户群体", "items": content.get("user_segments", [])},
        {"key": "business_flow", "title": "业务流程", "items": content.get("business_flow", [])},
        {"key": "operation_model", "title": "建议运营模式", "items": content.get("operation_model", [])},
        {
            "key": "hook_analysis",
            "title": "抓手分析",
            "summary": content.get("hook_analysis", {}).get("summary", ""),
            "items": content.get("hook_analysis", {}).get("hooks", []),
        },
        {"key": "capital_story", "title": "资本视角的业务故事", "summary": content.get("capital_story", "")},
        {"key": "product_capabilities", "title": "产品核心能力", "items": content.get("product_capabilities", [])},
        {"key": "tech_stack", "title": "技术选型", "items": content.get("tech_stack", [])},
        {"key": "risks", "title": "风险与验证建议", "items": content.get("risks", [])},
        {"key": "assumptions", "title": "当前假设", "items": content.get("assumptions", [])},
        {"key": "missing_info", "title": "待补充信息", "items": content.get("missing_info", [])},
    ]
    for section in sections:
        section["score"] = scores.get(section["key"])
    return sections


class BrainstormHandler(SimpleHTTPRequestHandler):
    server_version = "BrainstormLab/0.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, payload, status=HTTPStatus.OK, headers=None):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def start_sse(self):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def send_sse(self, event, payload):
        raw = "\n".join(
            [
                f"event: {event}",
                f"data: {json.dumps(payload, ensure_ascii=False)}",
                "",
                "",
            ]
        ).encode("utf-8")
        self.wfile.write(raw)
        self.wfile.flush()

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def get_cookie_session(self):
        cookie = SimpleCookie(self.headers.get("Cookie"))
        morsel = cookie.get("session_id")
        return morsel.value if morsel else ""

    def current_user(self, conn):
        session_id = self.get_cookie_session()
        if not session_id:
            return None
        row = conn.execute(
            """
            SELECT users.* FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.id = ? AND sessions.expires_at > ?
            """,
            (session_id, now_iso()),
        ).fetchone()
        return row

    def require_user(self, conn):
        user = self.current_user(conn)
        if not user:
            self.send_error_json(HTTPStatus.UNAUTHORIZED, "请先登录。")
            return None
        return user

    def route_parts(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = [part for part in parsed.path.split("/") if part]
        return parsed, parts

    def do_GET(self):
        parsed, parts = self.route_parts()
        if parsed.path == "/":
            return self.serve_static_file(STATIC_DIR / "index.html")
        if parts and parts[0] == "static":
            return self.serve_static_file(STATIC_DIR / "/".join(parts[1:]))
        if parts and parts[0] == "uploads":
            return self.serve_upload(parts[1:])
        if parts and parts[0] == "api":
            return self.handle_api_get(parts[1:])
        return self.serve_static_file(STATIC_DIR / "index.html")

    def do_POST(self):
        parsed, parts = self.route_parts()
        if parts and parts[0] == "api":
            return self.handle_api_post(parts[1:])
        return self.send_error_json(HTTPStatus.NOT_FOUND, "未找到接口。")

    def do_PUT(self):
        parsed, parts = self.route_parts()
        if parts and parts[0] == "api":
            return self.handle_api_put(parts[1:])
        return self.send_error_json(HTTPStatus.NOT_FOUND, "未找到接口。")

    def do_DELETE(self):
        parsed, parts = self.route_parts()
        if parts and parts[0] == "api":
            return self.handle_api_delete(parts[1:])
        return self.send_error_json(HTTPStatus.NOT_FOUND, "未找到接口。")

    def serve_static_file(self, path):
        path = Path(path)
        try:
            resolved = path.resolve()
            if STATIC_DIR.resolve() not in resolved.parents and resolved != STATIC_DIR.resolve() / "index.html":
                return self.send_error(HTTPStatus.FORBIDDEN)
            if not resolved.exists() or not resolved.is_file():
                return self.send_error(HTTPStatus.NOT_FOUND)
            content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
            raw = resolved.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)

    def serve_upload(self, parts):
        with connect_db() as conn:
            if not self.require_user(conn):
                return
        if not parts:
            return self.send_error(HTTPStatus.NOT_FOUND)
        stored = safe_filename(parts[-1])
        path = (UPLOAD_DIR / stored).resolve()
        if UPLOAD_DIR.resolve() not in path.parents or not path.exists():
            return self.send_error(HTTPStatus.NOT_FOUND)
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.end_headers()
        with path.open("rb") as fh:
            shutil.copyfileobj(fh, self.wfile)

    def handle_api_get(self, parts):
        with connect_db() as conn:
            if parts == ["me"]:
                user = self.current_user(conn)
                return self.send_json({"user": public_user(user) if user else None})
            user = self.require_user(conn)
            if not user:
                return
            if parts == ["members"]:
                rows = conn.execute("SELECT * FROM users ORDER BY created_at ASC").fetchall()
                return self.send_json({"members": [public_user(row) for row in rows]})
            if parts == ["invites"]:
                rows = conn.execute(
                    """
                    SELECT invites.*, users.name AS creator_name
                    FROM invites
                    LEFT JOIN users ON users.id = invites.created_by
                    ORDER BY invites.id DESC
                    LIMIT 20
                    """
                ).fetchall()
                return self.send_json({"invites": [row_to_dict(row) for row in rows]})
            if parts == ["ideas"]:
                rows = conn.execute(
                    "SELECT * FROM ideas ORDER BY updated_at DESC, id DESC"
                ).fetchall()
                return self.send_json(
                    {"ideas": [public_idea(conn, row, user["id"]) for row in rows]}
                )
            if len(parts) == 2 and parts[0] == "ideas":
                idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (parts[1],)).fetchone()
                if not idea:
                    return self.send_error_json(HTTPStatus.NOT_FOUND, "想法不存在。")
                return self.send_json({"idea": public_idea(conn, idea, user["id"], True)})
        return self.send_error_json(HTTPStatus.NOT_FOUND, "未找到接口。")

    def handle_api_post(self, parts):
        if parts == ["auth", "register"]:
            return self.register()
        if parts == ["auth", "login"]:
            return self.login()
        if parts == ["auth", "logout"]:
            return self.logout()
        with connect_db() as conn:
            user = self.require_user(conn)
            if not user:
                return
            if parts == ["invites"]:
                code = random_code(10)
                conn.execute(
                    """
                    INSERT INTO invites (code, created_by, uses, max_uses, created_at)
                    VALUES (?, ?, 0, NULL, ?)
                    """,
                    (code, user["id"], now_iso()),
                )
                return self.send_json({"invite": {"code": code}})
            if parts == ["ideas"]:
                try:
                    payload = self.read_json()
                except json.JSONDecodeError:
                    return self.send_error_json(HTTPStatus.BAD_REQUEST, "内容格式不正确。")
                title = (payload.get("title") or "").strip()
                body = (payload.get("body") or "").strip()
                if not title or not body:
                    return self.send_error_json(HTTPStatus.BAD_REQUEST, "标题和内容都需要填写。")
                now = now_iso()
                cursor = conn.execute(
                    """
                    INSERT INTO ideas (author_id, title, body, content_version, created_at, updated_at)
                    VALUES (?, ?, ?, 1, ?, ?)
                    """,
                    (user["id"], title, body, now, now),
                )
                idea_id = cursor.lastrowid
                conn.commit()
                idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea_id,)).fetchone()
                return self.send_json({"idea": public_idea(conn, idea, user["id"], True)}, HTTPStatus.CREATED)
            if len(parts) == 3 and parts[0] == "ideas" and parts[2] == "attachments":
                return self.upload_attachment(conn, user, parts[1])
            if len(parts) == 3 and parts[0] == "ideas" and parts[2] == "analysis-stream":
                return self.stream_analysis(conn, user, parts[1])
            if len(parts) == 3 and parts[0] == "ideas" and parts[2] == "clarifications":
                return self.save_clarification_answer(conn, user, parts[1])
            if len(parts) == 3 and parts[0] == "ideas" and parts[2] == "reanalyze":
                idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (parts[1],)).fetchone()
                if not idea:
                    return self.send_error_json(HTTPStatus.NOT_FOUND, "想法不存在。")
                if idea["author_id"] != user["id"]:
                    return self.send_error_json(HTTPStatus.FORBIDDEN, "只有作者可以重新分析。")
                analyze_and_store(conn, idea["id"], "manual")
                idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea["id"],)).fetchone()
                return self.send_json({"idea": public_idea(conn, idea, user["id"], True)})
        return self.send_error_json(HTTPStatus.NOT_FOUND, "未找到接口。")

    def handle_api_put(self, parts):
        with connect_db() as conn:
            user = self.require_user(conn)
            if not user:
                return
            if len(parts) == 2 and parts[0] == "ideas":
                idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (parts[1],)).fetchone()
                if not idea:
                    return self.send_error_json(HTTPStatus.NOT_FOUND, "想法不存在。")
                if idea["author_id"] != user["id"]:
                    return self.send_error_json(HTTPStatus.FORBIDDEN, "只能编辑自己的想法。")
                try:
                    payload = self.read_json()
                except json.JSONDecodeError:
                    return self.send_error_json(HTTPStatus.BAD_REQUEST, "内容格式不正确。")
                title = (payload.get("title") or "").strip()
                body = (payload.get("body") or "").strip()
                if not title or not body:
                    return self.send_error_json(HTTPStatus.BAD_REQUEST, "标题和内容都需要填写。")
                conn.execute(
                    """
                    UPDATE ideas
                    SET title = ?, body = ?, content_version = content_version + 1, updated_at = ?
                    WHERE id = ?
                    """,
                    (title, body, now_iso(), idea["id"]),
                )
                conn.commit()
                updated = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea["id"],)).fetchone()
                return self.send_json({"idea": public_idea(conn, updated, user["id"], True)})
        return self.send_error_json(HTTPStatus.NOT_FOUND, "未找到接口。")

    def handle_api_delete(self, parts):
        with connect_db() as conn:
            user = self.require_user(conn)
            if not user:
                return
            if len(parts) == 4 and parts[0] == "ideas" and parts[2] == "attachments":
                idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (parts[1],)).fetchone()
                if not idea:
                    return self.send_error_json(HTTPStatus.NOT_FOUND, "想法不存在。")
                if idea["author_id"] != user["id"]:
                    return self.send_error_json(HTTPStatus.FORBIDDEN, "只能修改自己的附件。")
                attachment = conn.execute(
                    "SELECT * FROM attachments WHERE id = ? AND idea_id = ?",
                    (parts[3], idea["id"]),
                ).fetchone()
                if not attachment:
                    return self.send_error_json(HTTPStatus.NOT_FOUND, "附件不存在。")
                path = UPLOAD_DIR / attachment["stored_name"]
                conn.execute("DELETE FROM attachments WHERE id = ?", (attachment["id"],))
                if path.exists():
                    path.unlink()
                conn.execute(
                    "UPDATE ideas SET content_version = content_version + 1, updated_at = ? WHERE id = ?",
                    (now_iso(), idea["id"]),
                )
                conn.commit()
                updated = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea["id"],)).fetchone()
                return self.send_json({"idea": public_idea(conn, updated, user["id"], True)})
        return self.send_error_json(HTTPStatus.NOT_FOUND, "未找到接口。")

    def stream_analysis(self, conn, user, idea_id):
        idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea_id,)).fetchone()
        if not idea:
            return self.send_error_json(HTTPStatus.NOT_FOUND, "想法不存在。")
        if idea["author_id"] != user["id"]:
            return self.send_error_json(HTTPStatus.FORBIDDEN, "只有作者可以更新分析。")

        material = idea_material(conn, idea)
        self.start_sse()

        def emit(event, payload):
            self.send_sse(event, payload)

        try:
            started = time.monotonic()
            emit("status", {"message": "正在阅读想法和上下文"})
            sys.stderr.write(
                f"[analysis-stream] idea={idea['id']} started elapsed={time.monotonic() - started:.2f}s\n"
            )

            model_started = {"seen": False}

            def on_model_delta(_delta):
                if model_started["seen"]:
                    return
                model_started["seen"] = True
                emit("status", {"message": "模型正在组织结构化分析"})

            analysis, fallback_reason = call_openai_analysis_stream(idea, material, on_model_delta)
            sys.stderr.write(
                f"[analysis-stream] idea={idea['id']} model_done elapsed={time.monotonic() - started:.2f}s fallback={bool(fallback_reason)}\n"
            )
            source = analysis.pop("_source", "openai") if analysis else "local"
            if not analysis:
                emit("status", {"message": "真实 AI 分析未返回，正在使用本地兜底分析"})
                analysis = build_mock_analysis(idea, material, source="local:stream")
                analysis["_fallback_reason"] = fallback_reason or "真实 AI 分析未返回结果。"
                source = "local"

            analysis = normalize_analysis(analysis)
            emit("status", {"message": "正在把分析写到右侧"})
            for section in analysis_stream_sections(analysis):
                emit("section", section)
                time.sleep(0.02)
            emit(
                "questions",
                {
                    "questions": analysis.get("clarifying_questions", []),
                    "message": "补充问题已在后台准备",
                },
            )

            latest = store_analysis(conn, idea["id"], analysis, source)
            conn.commit()
            updated = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea["id"],)).fetchone()
            emit("done", {"analysis": latest, "idea": public_idea(conn, updated, user["id"], True)})
            sys.stderr.write(
                f"[analysis-stream] idea={idea['id']} done elapsed={time.monotonic() - started:.2f}s source={source}\n"
            )
        except BrokenPipeError:
            return
        except Exception as error:
            try:
                emit("error", {"error": f"{type(error).__name__}: {error}"})
            except Exception:
                pass

    def save_clarification_answer(self, conn, user, idea_id):
        idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea_id,)).fetchone()
        if not idea:
            return self.send_error_json(HTTPStatus.NOT_FOUND, "想法不存在。")
        if idea["author_id"] != user["id"]:
            return self.send_error_json(HTTPStatus.FORBIDDEN, "只有作者可以回应澄清问题。")
        try:
            payload = self.read_json()
        except json.JSONDecodeError:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, "内容格式不正确。")
        question = payload.get("question") if isinstance(payload.get("question"), dict) else {}
        question_id = str(question.get("id") or payload.get("question_id") or "").strip()
        question_id = "".join(
            char if char.isalnum() or char in "_-" else "_"
            for char in question_id.lower()
        ).strip("_")
        question_text = str(question.get("question") or payload.get("question_text") or "").strip()
        answer = str(payload.get("answer") or "").strip()
        is_fallback = 1 if payload.get("is_fallback") else 0
        if not question_id or not question_text or not answer:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, "问题和回答都需要填写。")
        label = str(question.get("label") or payload.get("question_label") or "").strip()
        now = now_iso()
        conn.execute(
            """
            INSERT INTO clarification_answers (
                idea_id, question_id, question_label, question_text, answer, is_fallback, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(idea_id, question_id) DO UPDATE SET
                question_label = excluded.question_label,
                question_text = excluded.question_text,
                answer = excluded.answer,
                is_fallback = excluded.is_fallback,
                updated_at = excluded.updated_at
            """,
            (idea["id"], question_id, label, question_text, answer, is_fallback, now, now),
        )
        conn.commit()
        updated = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea["id"],)).fetchone()
        return self.send_json({"idea": public_idea(conn, updated, user["id"], True)})

    def register(self):
        try:
            payload = self.read_json()
        except json.JSONDecodeError:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, "内容格式不正确。")
        name = (payload.get("name") or "").strip()
        passcode = (payload.get("passcode") or "").strip()
        invite_code = (payload.get("inviteCode") or "").strip()
        if len(name) < 2 or len(passcode) < 4:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, "名称至少 2 个字，登录口令至少 4 位。")
        with connect_db() as conn:
            invite = conn.execute("SELECT * FROM invites WHERE code = ?", (invite_code,)).fetchone()
            if not invite:
                return self.send_error_json(HTTPStatus.FORBIDDEN, "邀请码不正确。")
            if invite["max_uses"] is not None and invite["uses"] >= invite["max_uses"]:
                return self.send_error_json(HTTPStatus.FORBIDDEN, "邀请码已达到使用次数。")
            if invite["expires_at"] and invite["expires_at"] < now_iso():
                return self.send_error_json(HTTPStatus.FORBIDDEN, "邀请码已过期。")
            salt, digest = hash_passcode(passcode)
            colors = ["#FFB000", "#00A676", "#3B82F6", "#EF476F", "#8B5CF6", "#14B8A6"]
            avatar_color = colors[secrets.randbelow(len(colors))]
            try:
                cursor = conn.execute(
                    """
                    INSERT INTO users (name, pass_salt, pass_hash, avatar_color, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (name, salt, digest, avatar_color, now_iso()),
                )
            except sqlite3.IntegrityError:
                return self.send_error_json(HTTPStatus.CONFLICT, "这个名称已经被使用。")
            conn.execute("UPDATE invites SET uses = uses + 1 WHERE id = ?", (invite["id"],))
            user = conn.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
            return self.start_session(conn, user, HTTPStatus.CREATED)

    def login(self):
        try:
            payload = self.read_json()
        except json.JSONDecodeError:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, "内容格式不正确。")
        name = (payload.get("name") or "").strip()
        passcode = (payload.get("passcode") or "").strip()
        with connect_db() as conn:
            user = conn.execute("SELECT * FROM users WHERE name = ?", (name,)).fetchone()
            if not user:
                return self.send_error_json(HTTPStatus.UNAUTHORIZED, "名称或口令不正确。")
            _, digest = hash_passcode(passcode, user["pass_salt"])
            if digest != user["pass_hash"]:
                return self.send_error_json(HTTPStatus.UNAUTHORIZED, "名称或口令不正确。")
            return self.start_session(conn, user, HTTPStatus.OK)

    def logout(self):
        session_id = self.get_cookie_session()
        with connect_db() as conn:
            if session_id:
                conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        headers = {"Set-Cookie": "session_id=; Path=/; Max-Age=0; SameSite=Lax"}
        return self.send_json({"ok": True}, headers=headers)

    def start_session(self, conn, user, status):
        session_id = secrets.token_urlsafe(32)
        expires = datetime.utcnow() + timedelta(days=SESSION_DAYS)
        conn.execute(
            "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (session_id, user["id"], now_iso(), expires.replace(microsecond=0).isoformat() + "Z"),
        )
        headers = {
            "Set-Cookie": (
                f"session_id={session_id}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={SESSION_DAYS * 24 * 60 * 60}"
            )
        }
        return self.send_json({"user": public_user(user)}, status, headers)

    def upload_attachment(self, conn, user, idea_id):
        idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea_id,)).fetchone()
        if not idea:
            return self.send_error_json(HTTPStatus.NOT_FOUND, "想法不存在。")
        if idea["author_id"] != user["id"]:
            return self.send_error_json(HTTPStatus.FORBIDDEN, "只能给自己的想法上传附件。")
        length = int(self.headers.get("Content-Length", "0") or "0")
        upload_limit = max_upload_bytes()
        if length > upload_limit:
            return self.send_error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "附件太大。")
        env = {
            "REQUEST_METHOD": "POST",
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(length),
        }
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ=env)
        file_item = form["file"] if "file" in form else None
        if isinstance(file_item, list):
            file_item = file_item[0] if file_item else None
        if file_item is None or not getattr(file_item, "filename", ""):
            return self.send_error_json(HTTPStatus.BAD_REQUEST, "没有收到文件。")
        original = safe_filename(file_item.filename)
        stored_name = f"{int(time.time())}-{secrets.token_hex(8)}-{original}"
        path = UPLOAD_DIR / stored_name
        size = 0
        with path.open("wb") as out:
            while True:
                chunk = file_item.file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > upload_limit:
                    out.close()
                    path.unlink(missing_ok=True)
                    return self.send_error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "附件太大。")
                out.write(chunk)
        content_type = file_item.type or mimetypes.guess_type(original)[0] or "application/octet-stream"
        conn.execute(
            """
            INSERT INTO attachments (idea_id, filename, stored_name, content_type, size, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (idea["id"], original, stored_name, content_type, size, now_iso()),
        )
        conn.execute(
            "UPDATE ideas SET content_version = content_version + 1, updated_at = ? WHERE id = ?",
            (now_iso(), idea["id"]),
        )
        conn.commit()
        updated = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea["id"],)).fetchone()
        return self.send_json({"idea": public_idea(conn, updated, user["id"], True)})


def main():
    load_dotenv()
    init_db()
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8765"))
    server = ThreadingHTTPServer((host, port), BrainstormHandler)
    print(f"Brainstorm Lab is running at http://{host}:{port}")
    print(f"Initial invite code: {os.getenv('INVITE_CODE', 'BRAINSTORM-2026')}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Brainstorm Lab.")


if __name__ == "__main__":
    main()
